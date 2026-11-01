# Daily job that replaces Vercel Cron: calls /api/cron/<Job> with the secret from apps\web\.env.production.local.
param([ValidateSet("sweep", "cleanup")][string]$Job, [int]$Port = 3010)
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$secret = ((Get-Content (Join-Path $repo "apps\web\.env.production.local")) | Where-Object { $_ -like "PRINTIO_CRON_SECRET=*" }) -replace "^PRINTIO_CRON_SECRET=", ""
$r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Headers @{ Authorization = "Bearer $secret" } "http://127.0.0.1:$Port/api/cron/$Job"
Add-Content (Join-Path $PSScriptRoot "cron.log") "$(Get-Date -Format s) $Job $($r.StatusCode)"
