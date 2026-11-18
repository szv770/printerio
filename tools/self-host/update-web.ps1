# INTERIM: delete this file when the website moves to Cloudflare (phase H/J in docs/TARGET-ARCHITECTURE.md).
# Rebuilds the website on this PC after the Agent's "Update this server" pulled new code. Run on demand by the scheduled
# task "Printio Web Update" (registered by setup-web.ps1, runs as SYSTEM, started by the Agent with `schtasks /Run`).
# It takes NO input from anywhere (only the port, fixed at registration), never pulls or installs (the Agent already did),
# and prints/stores no secrets (the build reads apps\web\.env.production.local itself; only its output goes to the log).
#
# How the swap works: the live site keeps serving its current build folder the whole time. The new build goes into the OTHER
# of two folders (apps\web\.next-blue / .next-green; the very first live folder is plain .next). Only when the build
# succeeded does it stop the site, record the new folder in active-dist.txt (run-web.ps1 reads that), start the site and
# wait for it to answer. If it does not answer, it records the old folder again and starts the old build. The old build
# is never deleted before the new one is healthy; it stays until the next update needs its folder.
# Status: C:\ProgramData\Printio\WebUpdate\status.json (state building/done/failed + message + time), log: update.log.
param([int]$Port = 3010)
$ErrorActionPreference = "Continue"   # native commands write progress to stderr; failures are checked explicitly below
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$web = Join-Path $repo "apps\web"
$dataRoot = if ($env:ProgramData) { $env:ProgramData } else { "C:\ProgramData" }
$dir = Join-Path $dataRoot "Printio\WebUpdate"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $dir "update.log"
$statusFile = Join-Path $dir "status.json"
$pointer = Join-Path $dir "active-dist.txt"
if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item $log "$log.old" -Force }

function Log($m) { "$(Get-Date -Format s) $m" | Add-Content $log }
function Set-Status($state, $message) {
  Log "$state : $message"
  (@{ state = $state; message = $message; at = (Get-Date -Format s) } | ConvertTo-Json) | Set-Content -Path $statusFile -Encoding UTF8
}
function Stop-Site {
  Stop-ScheduledTask "Printio Web" -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*next*start*$Port*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep 2
}
# Up = the site answers with 200-399 (the home page may redirect). A 5xx or no answer = not healthy.
function Test-Site {
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep 3
    try { $r = Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 "http://127.0.0.1:$Port/" -TimeoutSec 15 -ErrorAction Stop; if ([int]$r.StatusCode -lt 400) { return $true } }
    catch { if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -ge 200 -and [int]$_.Exception.Response.StatusCode -lt 400) { return $true } }
  }
  return $false
}
function Use-Build($name) {   # point run-web.ps1 at a build folder (plain .next = no pointer)
  if ($name -eq ".next") { Remove-Item $pointer -ErrorAction SilentlyContinue } else { Set-Content -Path $pointer -Value $name -Encoding ASCII }
}

$live = ".next"; $switching = $false
try {
  $live = if (Test-Path $pointer) { (Get-Content $pointer -Raw).Trim() } else { ".next" }
  if ($live -notmatch '^\.next(-blue|-green)?$') { $live = ".next" }
  $target = if ($live -eq ".next-blue") { ".next-green" } else { ".next-blue" }
  Set-Status "building" "Building the new website into $target while the current one ($live) keeps serving."

  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
  $next = Join-Path $web "node_modules\next\dist\bin\next"
  Set-Location $web
  Remove-Item (Join-Path $web $target) -Recurse -Force -ErrorAction SilentlyContinue   # the build before the live one; never the live one
  & $node "scripts\copy-pdfjs-assets.mjs" *>> $log
  $env:NEXT_DIST_DIR = $target
  & $node $next build *>> $log
  $buildExit = $LASTEXITCODE
  Remove-Item Env:NEXT_DIST_DIR -ErrorAction SilentlyContinue
  if ($buildExit -ne 0 -or -not (Test-Path (Join-Path $web "$target\BUILD_ID"))) {
    Remove-Item (Join-Path $web $target) -Recurse -Force -ErrorAction SilentlyContinue
    Set-Status "failed" "The new website did not build (see update.log). Nothing was changed: the site is still running $live."
    exit 1
  }

  Log "Build ok. Switching: stopping the site, then starting it on $target."
  $switching = $true
  Stop-Site
  Use-Build $target
  Start-ScheduledTask "Printio Web"
  if (Test-Site) {
    Set-Status "done" "The website was updated (now running $target). The previous build ($live) is kept in case it is needed."
    exit 0
  }

  Log "The new build did not answer. Rolling back to $live."
  Stop-Site
  Use-Build $live
  Start-ScheduledTask "Printio Web"
  if (Test-Site) {
    Set-Status "failed" "The new website built but did not start, so the previous one ($live) was put back and is running. See update.log and web.log."
  } else {
    Set-Status "failed" "The new website did not start AND the previous one did not answer after the rollback. Run tools\self-host\setup-web.ps1 on this PC. See update.log and web.log."
  }
  exit 1
} catch {
  Remove-Item Env:NEXT_DIST_DIR -ErrorAction SilentlyContinue
  if ($switching) { Use-Build $live; Start-ScheduledTask "Printio Web" -ErrorAction SilentlyContinue }   # never leave the site stopped
  Set-Status "failed" "The website update stopped with an error: $($_.Exception.Message)"
  exit 1
}
