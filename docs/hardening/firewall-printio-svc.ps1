<#
  Printio phase 2: keep the limited `printio-svc` account away from your other computers.

  WHAT IT DOES: adds Windows Firewall rules that apply ONLY to traffic made by the `printio-svc` account (the Printio
  gateway and print agent). Those programs may still reach: the internet (Supabase, Vercel, Cloudflare), the printer, and
  your DNS servers. They may NOT start connections to any other computer on your private networks (home/office LAN,
  Tailscale, link-local). So even a fully taken-over gateway cannot wander the network.
  It does NOT affect your own logins, Remote Desktop, SSH, Tailscale or cloudflared (they are different accounts), and it
  only blocks outgoing connections made by that one account.

  HOW TO RUN (on the print server, PowerShell as administrator):
    1. Preview, changes nothing:        .\firewall-printio-svc.ps1
    2. Turn on:                          .\firewall-printio-svc.ps1 -Apply
       Then within 10 minutes check: Admin -> Agents shows the print program online, and print a test page.
    3. If it all works, keep it:         .\firewall-printio-svc.ps1 -Keep
       (If you do nothing, the rules REMOVE THEMSELVES after 10 minutes, so a mistake cannot leave printing broken.)
    4. Remove it any time:               .\firewall-printio-svc.ps1 -Revert

  ADDING ANOTHER PRINTER LATER (one short command, takes effect at once, no 10-minute wait):
        .\firewall-printio-svc.ps1 -AddPrinter 192.168.100.170
  The script remembers every printer you give it (in C:\ProgramData\Printio\firewall-printers.txt).
  If a NEW printer shows as unreachable in Printio, this is the first thing to run.
  The first printer defaults to 192.168.100.168; use -PrinterIp to start with a different one.
#>
[CmdletBinding()]
param([switch]$Apply, [switch]$Keep, [switch]$Revert, [string[]]$PrinterIp = @(), [string]$AddPrinter = "")

$ErrorActionPreference = "Stop"
$Account = "printio-svc"
$RulePrefix = "Printio svc"
$TaskName = "Printio firewall auto-undo"
$StateFile = Join-Path $env:ProgramData "Printio\firewall-printers.txt"

function Say($m) { Write-Host $m }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Open PowerShell with 'Run as administrator' and run this again." }

# --- keep / revert -----------------------------------------------------------------------------------------------------
if ($Keep) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Say "Kept. The automatic undo was cancelled and the firewall rules stay on."
  return
}
if ($Revert) {
  Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Say "Removed all '$RulePrefix' firewall rules."
  return
}

# --- address maths: "all of these private ranges EXCEPT a few hosts" ---------------------------------------------------------
# Windows Firewall lets a Block rule win over an Allow rule, so the allowed hosts must be carved OUT of the blocked ranges.
function ConvertTo-Num([string]$ip) { $b = [Net.IPAddress]::Parse($ip).GetAddressBytes(); [uint64]($b[0] * 16777216 + $b[1] * 65536 + $b[2] * 256 + $b[3]) }
function ConvertTo-Ip([uint64]$n) { "{0}.{1}.{2}.{3}" -f [int](($n -shr 24) -band 255), [int](($n -shr 16) -band 255), [int](($n -shr 8) -band 255), [int]($n -band 255) }

function Get-RangesExcluding([string[]]$cidrs, [string[]]$exceptIps) {
  $except = $exceptIps | ForEach-Object { ConvertTo-Num $_ } | Sort-Object -Unique
  foreach ($c in $cidrs) {
    $ip, $bits = $c.Split("/")
    $size = [uint64][math]::Pow(2, 32 - [int]$bits)
    $start = ConvertTo-Num $ip
    $start = $start - ($start % $size)
    $end = $start + $size - 1
    $cursor = $start
    foreach ($e in ($except | Where-Object { $_ -ge $start -and $_ -le $end })) {
      if ($e -gt $cursor) { "{0}-{1}" -f (ConvertTo-Ip $cursor), (ConvertTo-Ip ($e - 1)) }
      $cursor = $e + 1
    }
    if ($cursor -le $end) { "{0}-{1}" -f (ConvertTo-Ip $cursor), (ConvertTo-Ip $end) }
  }
}

# --- gather ---------------------------------------------------------------------------------------------------------
$sid = (New-Object Security.Principal.NTAccount($Account)).Translate([Security.Principal.SecurityIdentifier]).Value
$sddl = "D:(A;;CC;;;$sid)"

$dns = Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ } | Select-Object -Unique
# Printers to keep reachable: the ones remembered from before, any given now, and the first-time default.
$saved = if (Test-Path $StateFile) { @(Get-Content $StateFile | Where-Object { $_ -match "^\d+\.\d+\.\d+\.\d+$" }) } else { @() }
if ($AddPrinter) {
  if ($AddPrinter -notmatch "^\d{1,3}(\.\d{1,3}){3}$" -or ($AddPrinter.Split(".") | Where-Object { [int]$_ -gt 255 })) { throw "'$AddPrinter' is not a printer address like 192.168.100.170." }
  $PrinterIp = @($PrinterIp) + @($AddPrinter)
}
$printers = @($saved) + @($PrinterIp)
if ($printers.Count -eq 0) { $printers = @("192.168.100.168") }
$printers = @($printers | Select-Object -Unique)
$allowed = @($printers) + @($dns | Where-Object { $_ -match "^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)" })
$allowed = $allowed | Select-Object -Unique

$v4Private = @("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10")
$v4Blocked = @(Get-RangesExcluding $v4Private $allowed)
$v6Blocked = @("fc00::/7", "fe80::/10")
$blocked = $v4Blocked + $v6Blocked

Say "Account:         $Account"
Say "Printers:        $($printers -join ', ')  (allowed, all ports)"
Say "DNS servers:     $(if ($dns) { $dns -join ', ' } else { '(none found)' })  (private ones stay allowed)"
Say "Stays allowed:   the internet, this computer itself (127.0.0.1), and the hosts above"
Say "Will be blocked: outgoing connections by '$Account' to these private ranges:"
$v4Blocked | ForEach-Object { Say "    $_" }
$v6Blocked | ForEach-Object { Say "    $_" }
Say ""

if (-not $Apply -and -not $AddPrinter) {
  foreach ($pr in $printers) {
    if (-not (Test-NetConnection -ComputerName $pr -Port 9100 -WarningAction SilentlyContinue).TcpTestSucceeded) {
      Write-Warning "This computer could not reach $pr on port 9100 right now. Check the printer address before you apply."
    }
  }
  Say "That was a preview: nothing was changed. To turn it on:  .\firewall-printio-svc.ps1 -Apply"
  return
}

# --- apply ------------------------------------------------------------------------------------------------------------
$alreadyOn = [bool](Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue)
New-Item -ItemType Directory -Force -Path (Split-Path $StateFile) | Out-Null
$printers | Set-Content $StateFile
Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "$RulePrefix - block LAN and Tailscale (outgoing)" -Description "Printio: the limited account that runs the gateway and agent may not start connections to other computers on private networks. See docs/SECURITY.md." `
  -Direction Outbound -Action Block -LocalUser $sddl -RemoteAddress $blocked -Profile Any -Enabled True | Out-Null
Say "Firewall rule added."

if ($AddPrinter -and $alreadyOn) {
  Say ""
  Say "Done: $AddPrinter is now allowed as well (the rule was updated in place). Check that printer in Printio."
  return
}

# Dead-man switch: remove the rules in 10 minutes unless the owner confirms with -Keep.
$cmd = "Get-NetFirewallRule -DisplayName '$RulePrefix*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule; Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false -ErrorAction SilentlyContinue"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -Command `"$cmd`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null

Say ""
Say "ON, with an automatic undo in 10 minutes. Now check:"
Say "  1. Admin -> Agents in Printio: the print program is online (green)."
Say "  2. Print a test page from your phone or laptop."
Say "  3. Press 'Update this server' once in Admin and confirm it finishes."
Say "If everything works, make it permanent:  .\firewall-printio-svc.ps1 -Keep"
Say "If anything is wrong, do nothing (it undoes itself) or run:  .\firewall-printio-svc.ps1 -Revert"
