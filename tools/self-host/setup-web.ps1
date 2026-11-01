# Runs the Printio web app on this PC (instead of Vercel). Run from anywhere: .\tools\self-host\setup-web.ps1
# Reads what it can from apps\gateway\.env (Supabase URL + service-role key, gateway secret, base domain) so
# nothing has to be pasted. Prompts only for anything it cannot find. Writes apps\web\.env.production.local
# (git-ignored), builds, registers startup + daily cron tasks, then starts the site on 127.0.0.1:$Port.
# It does NOT touch Cloudflare or Supabase dashboards (see docs/self-host.md for those two clicks-only steps).
param(
  [string]$Domain = "beta.printio.app",
  [int]$Port = 3010,
  [switch]$SkipBuild,       # rerun without reinstalling/rebuilding
  [switch]$SwitchServices   # also point the agent + gateway at this local site and restart them
)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $repo

function Read-DotEnv($path) {
  $h = @{}
  if (Test-Path $path) {
    foreach ($line in Get-Content $path) {
      if ($line -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$' -and -not $line.TrimStart().StartsWith('#')) {
        $h[$Matches[1]] = $Matches[2].Trim('"').Trim("'")
      }
    }
  }
  return $h
}
function Need($h, $key, $label) {
  if ($h[$key]) { return $h[$key] }
  return (Read-Host "Enter $label")
}

$gw = Read-DotEnv (Join-Path $repo "apps\gateway\.env")
$envFile = Join-Path $repo "apps\web\.env.production.local"
$old = Read-DotEnv $envFile

# The anon key is public by design (it ships in every browser bundle), so it is fixed here.
$anon = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrYWhhcmZ2anNyeGR1bWF6dWZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0NTYwMDMsImV4cCI6MjEwODAzMjAwM30.AvEEdbnbUZaGRcoXyOezP4_FBsGg0P6XTyzJ54kDBlw"
$supaUrl = if ($gw["SUPABASE_URL"]) { $gw["SUPABASE_URL"] } else { "https://qkaharfvjsrxdumazufe.supabase.co" }
$service = Need $gw "SUPABASE_SERVICE_ROLE_KEY" "the Supabase service-role key"
$gwSecret = Need $gw "GATEWAY_SHARED_SECRET" "the gateway shared secret"
$baseDomain = if ($gw["BASE_DOMAIN"]) { $gw["BASE_DOMAIN"] } else { "szvtech.org" }
$cron = if ($old["PRINTIO_CRON_SECRET"]) { $old["PRINTIO_CRON_SECRET"] } else { -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }) }

$lines = @(
  "NEXT_PUBLIC_SUPABASE_URL=$supaUrl",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY=$anon",
  "SUPABASE_SERVICE_ROLE_KEY=$service",
  "NEXT_PUBLIC_APP_URL=https://$Domain",
  "GATEWAY_SHARED_SECRET=$gwSecret",
  "GATEWAY_BASE_DOMAIN=$baseDomain",
  "PRINTIO_CRON_SECRET=$cron"
)
foreach ($k in "PRINTIO_BOOTSTRAP_ADMIN_EMAIL", "PRINTIO_BOOTSTRAP_ORG_NAME") { if ($old[$k]) { $lines += "$k=$($old[$k])" } }
[IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding $false))
Write-Host "Wrote $envFile"

if (-not $SkipBuild) {
  Write-Host "Installing and building (a few minutes)..."
  corepack enable
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE) { throw "pnpm install failed" }
  pnpm --filter "@printio/web" build
  if ($LASTEXITCODE) { throw "build failed" }
}

function Register-Task($name, $trigger, $script, $argText) {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`" $argText" -WorkingDirectory $repo
  $settings = New-ScheduledTaskSettingsSet -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -User "SYSTEM" -RunLevel Highest -Force | Out-Null
}
$web = Join-Path $PSScriptRoot "run-web.ps1"
$cronScript = Join-Path $PSScriptRoot "run-cron.ps1"
Register-Task "Printio Web" (New-ScheduledTaskTrigger -AtStartup) $web "-Port $Port"
Register-Task "Printio cron sweep" (New-ScheduledTaskTrigger -Daily -At "08:00") $cronScript "-Job sweep -Port $Port"
Register-Task "Printio cron cleanup" (New-ScheduledTaskTrigger -Daily -At "03:00") $cronScript "-Job cleanup -Port $Port"

Stop-ScheduledTask "Printio Web" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*next*start*$Port*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-ScheduledTask "Printio Web"
Write-Host "Waiting for the site to answer on 127.0.0.1:$Port ..."
$ok = $false
for ($i = 0; $i -lt 40 -and -not $ok; $i++) {
  Start-Sleep 3
  try { $r = Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 "http://127.0.0.1:$Port/" -ErrorAction Stop; $ok = $true }
  catch { if ($_.Exception.Response) { $ok = $true } }
}
if (-not $ok) { throw "The site did not come up. Check logs: $repo\tools\self-host\web.log" }
Write-Host "Site is up locally."

if ($SwitchServices) {
  $local = "http://127.0.0.1:$Port"
  foreach ($f in @(@("apps\gateway\.env", "WEB_BASE_URL"), @("apps\agent\.env", "PRINTIO_API_URL"))) {
    $p = Join-Path $repo $f[0]
    if (-not (Test-Path $p)) { Write-Host "Skipped $($f[0]) (not found)"; continue }
    Copy-Item $p "$p.bak" -Force
    $c = Get-Content $p | Where-Object { $_ -notmatch "^\s*#?\s*$($f[1])\s*=" }
    $c += "$($f[1])=$local"
    Set-Content $p $c
    Write-Host "Updated $($f[0]) (backup: $($f[0]).bak)"
  }
  Get-Service "*Printio*" -ErrorAction SilentlyContinue | ForEach-Object { Restart-Service $_ -Force; Write-Host "Restarted $($_.Name)" }
}
Write-Host "`nDone. Remaining by hand: the Cloudflare hostname $Domain -> http://localhost:$Port and the Supabase redirect URL (docs/self-host.md)."
