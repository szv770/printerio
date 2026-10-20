<#
.SYNOPSIS
  EXPERIMENT (untested until the owner runs it): send a plain PDF straight to the printer's raw port
  with a hand-written PJL header, to see whether the Kyocera accepts PDF directly. See docs/kyocera-raw-print.md.
.EXAMPLE
  . .\send-pdf.ps1                       # dot-source to define Send-Pdf (or paste the function)
  Send-Pdf C:\Temp\test.pdf
  Send-Pdf C:\Temp\test6.pdf -Pjl 'DUPLEX=ON','BINDING=LONGEDGE','OUTBIN=OPTIONFACEDOWN','STAPLEOPTION=ONE','FINISH=STAPLE'
  Send-Pdf C:\Temp\booklet.pdf -Pjl 'DUPLEX=ON','OUTBIN=KBOOKLET','FINISH=KREVERSEFOLD'
  Send-Pdf C:\Temp\test.pdf -NoEnterLanguage   # let the printer auto-detect PDF
#>
function Send-Pdf {
  param([string]$File, [string]$Ip = "192.168.100.168", [switch]$NoEnterLanguage, [string[]]$Pjl = @())
  $latin1 = [Text.Encoding]::GetEncoding(28591)
  $esc = [char]27; $uel = "$esc%-12345X"
  $hdr = "$uel@PJL`r`n@PJL JOB NAME=`"printio-test`"`r`n"
  foreach ($l in $Pjl) { $hdr += "@PJL SET $l`r`n" }
  if (-not $NoEnterLanguage) { $hdr += "@PJL ENTER LANGUAGE=PDF`r`n" }
  $pdf = [IO.File]::ReadAllBytes($File)
  $tail = "`r`n$uel@PJL EOJ NAME=`"printio-test`"`r`n$uel"
  $ms = New-Object IO.MemoryStream
  foreach ($part in @($latin1.GetBytes($hdr), $pdf, $latin1.GetBytes($tail))) { $ms.Write($part, 0, $part.Length) }
  $b = $ms.ToArray()
  $c = New-Object Net.Sockets.TcpClient($Ip, 9100)
  $s = $c.GetStream(); $s.Write($b, 0, $b.Length); $s.Close(); $c.Close()
  "Sent $($b.Length) bytes to ${Ip}:9100"
}
