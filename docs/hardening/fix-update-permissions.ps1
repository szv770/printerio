<#
  Printio: fix "The update did not finish ... EPERM: operation not permitted, lstat 'C:\Users\...\AppData'".

  WHY IT HAPPENS: since the Printio services run as the limited account `printio-svc`, the web "Update this server" button
  runs `pnpm install` as that account. pnpm keeps its package store inside the folder of the person who installed it
  (for example C:\Users\MLM Office\AppData\Local\pnpm\store). The limited account is not allowed to look there, so any
  update that needs new packages fails the first time. (A retry works because nothing new is needed the second time.)

  WHAT THIS DOES: lets `printio-svc` walk through the folders leading to the pnpm store (it may look at their
  attributes only: no listing, no reading of anything else in AppData) and gives it change access to the pnpm store
  folder itself. Nothing else in your profile becomes reachable.

  HOW TO RUN (on the print server, PowerShell as administrator):
    1. Preview, changes nothing:      .\fix-update-permissions.ps1
    2. Do it:                         .\fix-update-permissions.ps1 -Apply
    3. Then press "Update this server" in Printio Admin: it should finish the first time.
  To undo:  icacls "<each folder shown>" /remove printio-svc   (the preview lists them)
#>
[CmdletBinding()]
param([switch]$Apply)

$ErrorActionPreference = "Stop"
$Account = "printio-svc"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Open PowerShell with 'Run as administrator' and run this again." }
if (-not (Get-LocalUser -Name $Account -ErrorAction SilentlyContinue)) { throw "The account '$Account' does not exist. Run limit-printio-services.ps1 first." }

$gw = Get-CimInstance Win32_Service -Filter "Name='printioippgateway.exe'" -ErrorAction SilentlyContinue
if (-not $gw) { throw "The Printio gateway service was not found on this computer." }
$gwPath = $gw.PathName.Trim('"')
$cut = $gwPath.ToLower().IndexOf("\apps\gateway\")
if ($cut -lt 0) { throw "Could not work out the Printio folder from: $gwPath" }
$repoRoot = $gwPath.Substring(0, $cut)

# Where does pnpm keep its store for this checkout? Ask pnpm itself (as you, the administrator).
$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $pnpm) { throw "pnpm was not found on this computer's PATH. Open a normal PowerShell where 'pnpm' works and run this there." }
Push-Location $repoRoot
try { $store = (& $pnpm store path 2>$null | Select-Object -First 1) } finally { Pop-Location }
if (-not $store) { throw "Could not ask pnpm for its store folder." }
$store = $store.Trim()

# The path the update actually failed on can also be recorded inside node_modules.
$recorded = $null
$modules = Join-Path $repoRoot "node_modules\.modules.yaml"
if (Test-Path $modules) {
  $line = Select-String -Path $modules -Pattern "^storeDir:" | Select-Object -First 1
  if ($line) { $recorded = ($line.Line -replace "^storeDir:\s*", "").Trim().Trim("'").Trim('"') }
}

Write-Host "Printio folder:        $repoRoot"
Write-Host "pnpm store (current):  $store"
Write-Host "pnpm store (recorded): $(if ($recorded) { $recorded } else { '(none found)' })"
Write-Host ""

$stores = @($store, $recorded) | Where-Object { $_ } | ForEach-Object { $_ -replace "/", "\" } | Select-Object -Unique
$usersRoot = "C:\Users"
$walk = @()   # folders inside C:\Users that must be walkable
$change = @() # folders that need change access
foreach ($st in $stores) {
  if ($st.StartsWith($usersRoot, [StringComparison]::OrdinalIgnoreCase)) {
    # the store folder and its pnpm parent get change access; every folder above it (down from C:\Users\<name>) is walk-through only
    $change += $st
    $p = Split-Path $st -Parent
    while ($p -and $p.Length -gt $usersRoot.Length -and $p.StartsWith($usersRoot, [StringComparison]::OrdinalIgnoreCase)) { $walk += $p; $p = Split-Path $p -Parent }
  } else {
    Write-Host "Note: the store '$st' is outside C:\Users; granting change access only."
    $change += $st
  }
}
$walk = $walk | Select-Object -Unique
$change = $change | Select-Object -Unique

Write-Host "Folders '$Account' will be allowed to walk through (attributes only):"
$walk | ForEach-Object { Write-Host "    $_" }
Write-Host "Folders '$Account' will get change access to:"
$change | ForEach-Object { Write-Host "    $_" }
Write-Host ""

if (-not $Apply) {
  Write-Host "That was a preview: nothing was changed. To do it:  .\fix-update-permissions.ps1 -Apply"
  return
}

foreach ($w in $walk) { if (Test-Path $w) { & icacls.exe $w /grant "${Account}:(X,RA)" | Out-Null } }
foreach ($c in $change) { if (Test-Path $c) { & icacls.exe $c /grant "${Account}:(OI)(CI)(M)" /T /C /Q | Out-Null } else { New-Item -ItemType Directory -Force -Path $c | Out-Null; & icacls.exe $c /grant "${Account}:(OI)(CI)(M)" /T /C /Q | Out-Null } }
Write-Host "Done. Now press 'Update this server' in Printio Admin: it should finish the first time."
