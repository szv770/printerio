<#
.SYNOPSIS
  Send a file (typically a captured Kyocera .prn) straight to a printer's raw port, bypassing the
  Windows print queue. Optionally edit the readable PJL header first.

.DESCRIPTION
  Experiment tooling, see docs/kyocera-raw-print.md. UNTESTED against a real printer as of writing.
  Does NOT have to be a script: the core is the 5 lines under "# --- send ---"; paste them into a
  PowerShell window if you prefer. The script just adds parameters and a safe header-edit step.

.PARAMETER PrinterIp  Printer address (the "IP_x.x.x.x" in the queue's Ports tab).
.PARAMETER File       The .prn to send.
.PARAMETER Port       Raw port, default 9100.
.PARAMETER Replace    Hashtable of PJL header edits, e.g. @{ 'STAPLEOPTION=ONE' = 'STAPLEOPTION=ONEOPPOSED' }.
                      Applied ONLY to the text before "@PJL ENTER LANGUAGE"; a key that is not found is an
                      error (so a typo never silently sends an unmodified job).
.PARAMETER DryRun     Write the (edited) bytes to <File>.edited.prn and do not send anything.

.EXAMPLE
  .\send-raw.ps1 -PrinterIp 10.0.0.5 -File C:\Temp\jobD.prn
.EXAMPLE
  .\send-raw.ps1 -PrinterIp 10.0.0.5 -File C:\Temp\jobD.prn -DryRun -Replace @{ 'STAPLEOPTION=ONE' = 'STAPLEOPTION=ONEOPPOSED' }
#>
param(
  [Parameter(Mandatory)][string]$PrinterIp,
  [Parameter(Mandatory)][string]$File,
  [int]$Port = 9100,
  [hashtable]$Replace,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$bytes = [IO.File]::ReadAllBytes($File)

if ($Replace) {
  # Latin-1 maps bytes 0-255 to chars 1:1, so the binary PCL XL part survives the round trip untouched.
  $latin1 = [Text.Encoding]::GetEncoding(28591)
  $text = $latin1.GetString($bytes)
  $marker = '@PJL ENTER LANGUAGE'
  $cut = $text.IndexOf($marker)
  if ($cut -lt 0) { throw "No '$marker' found - is this a Kyocera .prn?" }
  $header = $text.Substring(0, $cut)
  $rest = $text.Substring($cut)
  foreach ($k in $Replace.Keys) {
    if (-not $header.Contains($k)) { throw "Header edit '$k' not found in the PJL header." }
    $header = $header.Replace($k, [string]$Replace[$k])
  }
  $bytes = $latin1.GetBytes($header + $rest)
}

if ($DryRun) {
  $out = "$File.edited.prn"
  [IO.File]::WriteAllBytes($out, $bytes)
  Write-Host "Dry run: wrote $($bytes.Length) bytes to $out (nothing sent)."
  return
}

# --- send ---
$client = New-Object Net.Sockets.TcpClient
$client.Connect($PrinterIp, $Port)
$stream = $client.GetStream()
$stream.Write($bytes, 0, $bytes.Length)
$stream.Flush(); $stream.Close(); $client.Close()
Write-Host "Sent $($bytes.Length) bytes to ${PrinterIp}:$Port."
