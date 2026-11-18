<#
  Printio: run the two Printio services as a small, limited Windows account instead of LocalSystem.

  WHY: LocalSystem is the most powerful account on the computer. The gateway reads requests from the internet, so if a
  bug in it were ever found, that bug would run with that power. As `printio-svc` (not an administrator, cannot sign in
  or use Remote Desktop, nobody knows its password) a taken-over gateway can only touch what that account can touch.

  HOW TO RUN (on the print server, in PowerShell opened with "Run as administrator"):
    1. Preview, changes nothing:      .\limit-printio-services.ps1
    2. Do it:                         .\limit-printio-services.ps1 -Apply
    3. Undo it at any time:           .\limit-printio-services.ps1 -Revert

  SAFE BY DESIGN: it backs up the service settings first, switches the gateway, then the agent, one at a time, and if a
  service is not running again 30 seconds later it puts that service back on LocalSystem by itself.
  It never prints the password (a random 40-character one, used once and thrown away).
#>
[CmdletBinding()]
param([switch]$Apply, [switch]$Revert)

$ErrorActionPreference = "Stop"
$Account = "printio-svc"
$Services = @(
  @{ Name = "printioippgateway.exe"; Display = "Printio IPP Gateway" },
  @{ Name = "printioprintagent.exe"; Display = "Printio Print Agent" }
)

function Say($m) { Write-Host $m }
function Do-It($what, [scriptblock]$action) {
  if ($Apply -or $Revert) { Say "  DOING: $what"; & $action } else { Say "  WOULD DO: $what" }
}

# --- checks ---------------------------------------------------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Open PowerShell with 'Run as administrator' and run this again." }

$found = @{}
foreach ($s in $Services) {
  $svc = Get-CimInstance Win32_Service -Filter "Name='$($s.Name)'" -ErrorAction SilentlyContinue
  if (-not $svc) { throw "Service '$($s.Name)' was not found on this computer. This script is for the Printio server." }
  $found[$s.Name] = $svc
}

# --- revert ---------------------------------------------------------------------------------------------------------
if ($Revert) {
  Say "Putting both services back on LocalSystem..."
  foreach ($s in $Services) {
    & sc.exe config $s.Name obj= LocalSystem password= "" | Out-Null
    Restart-Service -Name $s.Name -Force
    Say "  $($s.Display): back on LocalSystem and restarted."
  }
  Say "Done. (The printio-svc account and folder permissions were left in place; they do no harm.)"
  return
}

# --- work out the folders ----------------------------------------------------------------------------------------------
$gwPath = $found["printioippgateway.exe"].PathName.Trim('"')
$cut = $gwPath.ToLower().IndexOf("\apps\gateway\")
if ($cut -lt 0) { throw "Could not work out the Printio folder from: $gwPath" }
$repoRoot = $gwPath.Substring(0, $cut)
$dataDir = Join-Path ($env:ProgramData) "Printio"
Say "Printio folder:  $repoRoot"
Say "Printio data:    $dataDir"
foreach ($s in $Services) { Say ("Now running as:  {0,-24} {1}" -f $s.Display, $found[$s.Name].StartName) }
Say ""

# The folder where node.exe etc. live may be inside a user profile; find it from the service wrapper's XML.
$extraPaths = @()
foreach ($s in $Services) {
  $xml = Join-Path (Split-Path $found[$s.Name].PathName.Trim('"')) ($s.Name -replace "\.exe$", ".xml")
  if (Test-Path $xml) {
    $exe = ([xml](Get-Content $xml -Raw)).service.executable
    if ($exe) { $resolved = (Get-Command $exe -ErrorAction SilentlyContinue).Source; if (-not $resolved) { $resolved = $exe }; $extraPaths += $resolved }
  }
}
# The update button also needs node, pnpm and git; if any of them lives inside a user profile the account must be able to run it.
foreach ($tool in @("node", "pnpm", "git")) {
  $c = Get-Command $tool -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c -and $c.Source) { $extraPaths += $c.Source }
}
$extraPaths = $extraPaths | Where-Object { $_ } | Select-Object -Unique
foreach ($p in $extraPaths) { Say "Program used:     $p" }
Say ""

# --- helpers --------------------------------------------------------------------------------------------------------
function Get-AccountSid { (New-Object Security.Principal.NTAccount($Account)).Translate([Security.Principal.SecurityIdentifier]).Value }

function Add-UserRight([string]$right, [string]$sid) {
  $tmp = Join-Path $env:TEMP ("printio-sec-" + [guid]::NewGuid().ToString("N"))
  $inf = "$tmp.inf"; $db = "$tmp.sdb"
  try {
    & secedit.exe /export /cfg $inf /areas USER_RIGHTS | Out-Null
    $lines = Get-Content $inf -Encoding Unicode
    $done = $false
    $out = foreach ($l in $lines) {
      if ($l -match "^$right\s*=\s*(.*)$") {
        $done = $true
        if ($Matches[1] -match [regex]::Escape($sid)) { $l } else { "$right = $($Matches[1]),*$sid" }
      } else { $l }
    }
    if (-not $done) { $out = $out | ForEach-Object { if ($_ -eq "[Privilege Rights]") { "[Privilege Rights]"; "$right = *$sid" } else { $_ } } }
    $out | Set-Content $inf -Encoding Unicode
    & secedit.exe /configure /db $db /cfg $inf /areas USER_RIGHTS /quiet | Out-Null
  } finally { Remove-Item "$tmp*" -Force -ErrorAction SilentlyContinue }
}

function Grant-TraverseChain([string]$path) {
  # Lets the account walk THROUGH the folders above `path` inside C:\Users (to reach it) without listing or reading them.
  $usersRoot = "C:\Users"
  $p = Split-Path $path -Parent
  while ($p -and $p.Length -gt $usersRoot.Length -and $p.StartsWith($usersRoot, [StringComparison]::OrdinalIgnoreCase)) {
    & icacls.exe $p /grant "${Account}:(X)" | Out-Null
    $p = Split-Path $p -Parent
  }
}

# --- the plan ------------------------------------------------------------------------------------------------------
Say "PLAN"
$pw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
$secure = ConvertTo-SecureString $pw -AsPlainText -Force

Do-It "create (or refresh) the limited account '$Account' with a random password nobody will ever need" {
  if (Get-LocalUser -Name $Account -ErrorAction SilentlyContinue) { Set-LocalUser -Name $Account -Password $secure }
  else {
    New-LocalUser -Name $Account -Password $secure -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -Description "Runs the Printio services with limited rights" | Out-Null
    Add-LocalGroupMember -Group "Users" -Member $Account -ErrorAction SilentlyContinue
  }
}
Do-It "allow '$Account' to run as a service, and forbid it from signing in at the keyboard or over Remote Desktop" {
  $sid = Get-AccountSid
  Add-UserRight "SeServiceLogonRight" $sid
  Add-UserRight "SeDenyInteractiveLogonRight" $sid
  Add-UserRight "SeDenyRemoteInteractiveLogonRight" $sid
}
Do-It "let '$Account' walk through your user folder to reach the Printio folder (no listing, no reading of anything else)" { Grant-TraverseChain $repoRoot }
Do-It "give '$Account' change access to the Printio folder only (needed to run, write logs, and to update from the web app)" {
  & icacls.exe $repoRoot /grant "${Account}:(OI)(CI)(M)" /T /C /Q | Out-Null
}
Do-It "tell git the Printio folder is safe for '$Account' (git refuses folders owned by someone else otherwise, which would break the update button)" {
  $gitExe = (Get-Command git -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if ($gitExe) { & $gitExe config --system --add safe.directory ($repoRoot -replace "\\", "/") }
  else { Write-Warning "git was not found on this computer's PATH; the update button may need this done by hand." }
}
Do-It "give '$Account' change access to the Printio data folder (the agent's saved settings)" {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  & icacls.exe $dataDir /grant "${Account}:(OI)(CI)(M)" /T /C /Q | Out-Null
}
foreach ($p in $extraPaths) {
  Do-It "let '$Account' run $p" {
    Grant-TraverseChain $p
    & icacls.exe (Split-Path $p -Parent) /grant "${Account}:(OI)(CI)(RX)" /C /Q | Out-Null
  }
}

# back up what is there now, so nothing is lost
$backup = Join-Path $dataDir ("hardening-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".txt")
Do-It "save the current service settings to $backup" {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  $o = foreach ($s in $Services) { "== $($s.Name) =="; (& sc.exe qc $s.Name); (& sc.exe sdshow $s.Name) }
  $o | Set-Content $backup
}

foreach ($s in $Services) {
  Do-It "switch '$($s.Display)' to run as '$Account', restart it, and undo by itself if it does not come back" {
    & sc.exe config $s.Name obj= ".\$Account" password= $pw | Out-Null
    Restart-Service -Name $s.Name -Force -ErrorAction SilentlyContinue
    $ok = $false
    for ($i = 0; $i -lt 15; $i++) { Start-Sleep -Seconds 2; if ((Get-Service -Name $s.Name).Status -eq "Running") { $ok = $true } else { $ok = $false } }
    if (-not $ok) {
      & sc.exe config $s.Name obj= LocalSystem password= "" | Out-Null
      Restart-Service -Name $s.Name -Force -ErrorAction SilentlyContinue
      throw "'$($s.Display)' did not stay running as '$Account'. It was put back on LocalSystem and nothing is broken. Look at the log in the 'daemon' folder next to it and tell the next session."
    }
    Say "  OK: $($s.Display) is running as $Account."
  }
}

Do-It "let '$Account' restart the gateway service (the web app's update button restarts it)" {
  $sid = Get-AccountSid
  $sd = ((& sc.exe sdshow "printioippgateway.exe") -join "").Trim()
  if ($sd -notmatch [regex]::Escape($sid)) {
    $ace = "(A;;LCLORPWPRC;;;$sid)"
    $new = if ($sd -match "S:") { $sd -replace "S:", "$ace`S:" } else { "$sd$ace" }
    & sc.exe sdset "printioippgateway.exe" $new | Out-Null
  }
}

Say ""
if ($Apply) {
  Say "FINISHED. Check these three things:"
  Say "  1. Admin -> Agents in Printio: the print program shows as online (green) within a minute."
  Say "  2. Print a test page from your phone or laptop (the gateway)."
  Say "  3. In Printio Admin, press 'Update this server' once and confirm it finishes."
  Say "If anything is wrong: .\limit-printio-services.ps1 -Revert"
} else {
  Say "That was a preview: nothing was changed. To do it for real:  .\limit-printio-services.ps1 -Apply"
}
