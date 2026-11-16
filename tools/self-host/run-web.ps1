# Started by the "Printio Web" scheduled task (runs as SYSTEM). Runs the production build on 127.0.0.1.
# Uses node directly: pnpm/corepack are per-user and would stop to ask to download pnpm under SYSTEM.
param([int]$Port = 3010)
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$web = Join-Path $repo "apps\web"
Set-Location $web
$log = Join-Path $PSScriptRoot "web.log"
if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item $log "$log.old" -Force }
# INTERIM (delete with update-web.ps1 when the website moves to Cloudflare): update-web.ps1 builds into a second folder and
# records the live one here. Only the two exact folder names are accepted; anything else means the normal .next.
$dataRoot = if ($env:ProgramData) { $env:ProgramData } else { "C:\ProgramData" }
$pointer = Join-Path $dataRoot "Printio\WebUpdate\active-dist.txt"
$dist = if (Test-Path $pointer) { (Get-Content $pointer -Raw).Trim() } else { "" }
if ($dist -match '^\.next-(blue|green)$' -and (Test-Path (Join-Path $web $dist))) { $env:NEXT_DIST_DIR = $dist } else { Remove-Item Env:NEXT_DIST_DIR -ErrorAction SilentlyContinue }
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
$next = Join-Path $web "node_modules\next\dist\bin\next"
"$(Get-Date -Format s) starting: $node $next start -p $Port (build folder: $(if ($env:NEXT_DIST_DIR) { $env:NEXT_DIST_DIR } else { '.next' }))" | Add-Content $log
& $node $next start -p $Port -H 127.0.0.1 *>> $log
