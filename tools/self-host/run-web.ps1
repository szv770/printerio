# Started by the "Printio Web" scheduled task (runs as SYSTEM). Runs the production build on 127.0.0.1.
# Uses node directly: pnpm/corepack are per-user and would stop to ask to download pnpm under SYSTEM.
param([int]$Port = 3010)
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$web = Join-Path $repo "apps\web"
Set-Location $web
$log = Join-Path $PSScriptRoot "web.log"
if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item $log "$log.old" -Force }
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
$next = Join-Path $web "node_modules\next\dist\bin\next"
"$(Get-Date -Format s) starting: $node $next start -p $Port" | Add-Content $log
& $node $next start -p $Port -H 127.0.0.1 *>> $log
