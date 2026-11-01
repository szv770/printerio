# Started by the "Printio Web" scheduled task. Runs the production build on 127.0.0.1.
param([int]$Port = 3010)
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $repo
$log = Join-Path $PSScriptRoot "web.log"
if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item $log "$log.old" -Force }
pnpm --filter "@printio/web" exec next start -p $Port -H 127.0.0.1 *>> $log
