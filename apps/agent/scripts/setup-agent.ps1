<#
.SYNOPSIS
  One-click setup/launcher for the Printio Print Agent, for a non-technical
  first-time install on a Windows machine.

.DESCRIPTION
  This is a thin wrapper around the Agent's real CLI (apps/agent/src/index.ts:
  `register`, `start`, `install-service`), invoked exactly as documented in
  apps/agent/README.md and docs/agent-install.md, via
  `pnpm --filter @printio/agent ...`. It adds NO new Agent functionality - it
  only automates the sequence of typed commands a manual install otherwise
  requires, and prompts for the two pieces of information only a human can
  supply (the enrollment code, and this organization's Printio cloud URL).

  UNTESTED ON A REAL WINDOWS MACHINE. This was written and reviewed in a
  sandboxed Linux container with no Windows, no real PowerShell host, and no
  way to execute this file - exactly the same limitation documented in
  apps/agent/README.md's "Testing status" section for the rest of the Agent.
  Treat this script the same way: reviewed carefully, but not exercised.
  Before trusting it, run it once on a real Windows machine and watch it
  work through every step below.

  You can double-click setup-agent.bat (next to this file) again any time
  after a successful run - it detects what's already done (dependencies
  installed, Agent already registered) and skips straight to the
  run-now-or-install-as-a-service prompt.

  Before the interactive part, it verifies the things the Agent genuinely
  cannot work without, at setup time rather than at print time: that
  SumatraPDF is not merely present but actually startable (a corrupt or
  wrong-architecture download is caught here, not by a real user's print
  job), that Get-Printer/PrintManagement is available, and that at least one
  Windows print queue exists. apps/agent/src/dependency-check.ts runs the
  same SumatraPDF check again when the Agent itself starts, so a machine
  that degrades after setup is caught too.

  It also prints which git commit it is running, and restarts itself if its
  own file was changed by the update check - see the long comment at step 0,
  which explains a real support round that cost.

.NOTES
  Called via setup-agent.bat, which is what makes this double-click-able
  (Windows opens a bare .ps1 in a text editor instead of running it).
#>

param(
    # Internal flag only - used when this script re-launches itself elevated
    # (as Administrator) to run `install-service`. Not meant to be passed by
    # hand; see Invoke-InstallServiceFlow below.
    [switch]$InstallServiceElevated,

    # Internal flag only - set when this script re-launches ITSELF because
    # step 0's `git pull` just replaced this very file on disk. See the long
    # comment at step 0 for why that re-launch is mandatory rather than
    # cosmetic. It exists purely to make the re-launch happen exactly once
    # (the relaunched run skips the update check entirely, so there is no way
    # for this to loop).
    [switch]$Relaunched
)

$ErrorActionPreference = "Stop"

# Set when this run handed off to a relaunched copy of itself that has
# already done its own "Press Enter to close" pause - so the outer finally
# below doesn't ask a second time for the same window.
$script:SkipFinalPause = $false

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

# This script lives at <repo>\apps\agent\scripts\setup-agent.ps1.
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$AgentDir = Join-Path $RepoRoot "apps\agent"
$AgentPackageJsonPath = Join-Path $AgentDir "package.json"
$EnvFilePath = Join-Path $AgentDir ".env"
$EnvExamplePath = Join-Path $AgentDir ".env.example"

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

function Write-Step {
    param([string]$Text)
    Write-Host ""
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Text)
    Write-Host "  [OK] $Text" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Text)
    Write-Host "  [!]  $Text" -ForegroundColor Yellow
}

function Write-Info {
    param([string]$Text)
    Write-Host "  $Text"
}

function Get-LocalStoragePath {
    # Mirrors apps/agent/src/config.ts defaultLocalStoragePath()/
    # PRINTIO_LOCAL_STORAGE_PATH handling exactly, so "is this Agent already
    # registered?" is checked against the real place the Agent itself will
    # look, not a guess.
    if ($env:PRINTIO_LOCAL_STORAGE_PATH -and $env:PRINTIO_LOCAL_STORAGE_PATH.Trim() -ne "") {
        return $env:PRINTIO_LOCAL_STORAGE_PATH.Trim()
    }
    $programData = $env:ProgramData
    if (-not $programData -or $programData.Trim() -eq "") { $programData = "C:\ProgramData" }
    return Join-Path $programData "Printio\Agent"
}

function Show-StopMessage {
    # For failures before the Agent's own process/logger ever ran (missing
    # Node, missing pnpm, `pnpm install` failing) - there is no Agent log
    # file yet, so point at whatever's already on screen instead.
    param([string]$Message)
    Write-Host ""
    Write-Host "STOPPED: $Message" -ForegroundColor Red
    Write-Host "See the messages above for the exact error. Fix that, then double-click setup-agent.bat again." -ForegroundColor Yellow
}

function Show-RunFailure {
    # For failures from the Agent's own commands (register/start/
    # install-service) - these do create a log file, so point at it.
    param([string]$Message)
    Write-Host ""
    Write-Host "STOPPED: $Message" -ForegroundColor Red
    $logDir = Join-Path (Get-LocalStoragePath) "logs"
    Write-Host "For more detail, see:" -ForegroundColor Yellow
    Write-Host "  - the messages printed above (from the Agent itself)" -ForegroundColor Yellow
    Write-Host "  - the Agent's log file (one per day) in: $logDir" -ForegroundColor Yellow
    Write-Host "  (docs\agent-install.md section 6, 'Logs', explains what to look for there)" -ForegroundColor Yellow
}

function Test-IsElevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-DotEnvValues {
    # Parses a .env file into an ordered hashtable of KEY -> value.
    #
    # DELIBERATELY BUG-COMPATIBLE WITH `dotenv` (the Node library
    # apps/agent/src/index.ts uses to read the SAME file), because the whole
    # point of this script reading .env at all is to make the same decisions
    # the Agent will make. Any place the two parsers disagree is a bug that
    # presents as "the setup script says it's configured but the Agent says
    # it isn't" (or the reverse), which is unfalsifiable from a support
    # screenshot. Verified against dotenv@17.4.2's own LINE regex:
    #
    #  - LAST occurrence of a duplicated key wins. dotenv builds an object
    #    and assigns in file order, so the last assignment stands. The
    #    original version of this function took the FIRST occurrence (its
    #    "already set? don't touch it" guard skipped every later line), which
    #    silently disagreed with the Agent whenever a key appeared twice -
    #    and Set-DotEnvValue below used to be able to *produce* duplicates.
    #  - An unquoted value ends at the first "#": dotenv's value group is
    #    `[^#\r\n]+`, so `KEY=value # note` is `value`, not `value # note`.
    #    A quoted value keeps everything inside the quotes verbatim.
    #  - `export KEY=value` is accepted (dotenv allows the prefix).
    param([string]$Path)
    $values = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Path)) { return $values }
    # Get-Content splits on CR, LF, and CRLF alike, so a file written by any
    # editor (or committed with LF endings and checked out unchanged) parses
    # the same; the Trim() below also removes any stray CR a lone \r would
    # otherwise leave attached to the value.
    foreach ($rawLine in (Get-Content -LiteralPath $Path)) {
        $line = $rawLine.Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { continue }
        $idx = $line.IndexOf("=")
        if ($idx -lt 1) { continue }
        $key = $line.Substring(0, $idx).Trim()
        if ($key -match "^export\s+(.+)$") { $key = $Matches[1].Trim() }
        if ($key -eq "") { continue }
        $value = $line.Substring($idx + 1).Trim()

        $isQuoted = $false
        if ($value.Length -ge 2) {
            $isDoubleQuoted = $value.StartsWith('"') -and $value.EndsWith('"')
            $isSingleQuoted = $value.StartsWith("'") -and $value.EndsWith("'")
            if ($isDoubleQuoted -or $isSingleQuoted) {
                $value = $value.Substring(1, $value.Length - 2)
                $isQuoted = $true
            }
        }
        if (-not $isQuoted) {
            $hashIdx = $value.IndexOf("#")
            if ($hashIdx -ge 0) { $value = $value.Substring(0, $hashIdx).TrimEnd() }
        }

        $values[$key] = $value
    }
    return $values
}

function Import-DotEnvFile {
    # Loads a .env file into this process's environment (never overriding a
    # variable that's already set - e.g. a real Windows environment variable
    # someone configured takes priority over .env, matching dotenv's own
    # never-override behavior).
    #
    # apps/agent/src/index.ts loads .env itself, so this is not required to
    # make `pnpm --filter @printio/agent ...` see these values - but THIS
    # SCRIPT still needs them in its own PowerShell process to make its own
    # decisions (the SumatraPDF check and the PRINTIO_API_URL prompt both
    # read $env:... directly, before any Node process ever starts).
    param([string]$Path)
    $values = Get-DotEnvValues -Path $Path
    foreach ($key in $values.Keys) {
        $value = $values[$key]
        # An empty value means "not configured" everywhere in this repo
        # (src/config.ts treats "" exactly like unset for every variable), so
        # don't set it. This also avoids `Set-Item Env:\X -Value ""`, which
        # errors on Windows PowerShell - and under this script's
        # $ErrorActionPreference = "Stop" that error would abort the entire
        # run with a generic "unexpected error" instead of a useful message.
        if ($null -eq $value -or $value -eq "") { continue }
        if (-not (Test-Path -LiteralPath "Env:\$key")) {
            Set-Item -LiteralPath "Env:\$key" -Value $value
        }
    }
}

function Set-DotEnvValue {
    # Writes (or updates) a single KEY=VALUE line in a .env file, preserving
    # every other line as-is. Used so the Printio cloud URL, once typed in,
    # is only ever asked for once.
    #
    # Rewrites the FIRST line that declares this key (commented or not) and
    # DROPS any later line that declares it too, so the file always ends up
    # with exactly one active declaration. The previous version replaced
    # every matching line with the new value, which turned e.g. a template's
    # commented-out `# PRINTIO_API_URL=...` plus a real
    # `PRINTIO_API_URL=...` into two identical active lines, and grew one
    # more duplicate on every subsequent write. That mattered because this
    # script and the Agent's own dotenv parser had opposite duplicate-key
    # precedence (see Get-DotEnvValues) - so a duplicated key was a live
    # "these two disagree about my configuration" hazard, not just untidy.
    param([string]$Path, [string]$Key, [string]$Value)
    $lines = @()
    if (Test-Path -LiteralPath $Path) { $lines = @(Get-Content -LiteralPath $Path) }
    $found = $false
    $newLines = @()
    foreach ($line in $lines) {
        if ($line -match "^\s*#?\s*(export\s+)?$([regex]::Escape($Key))\s*=") {
            if (-not $found) {
                $newLines += "$Key=$Value"
                $found = $true
            }
            # else: a duplicate declaration of the same key - drop it.
        } else {
            $newLines += $line
        }
    }
    if (-not $found) { $newLines += "$Key=$Value" }
    Set-Content -LiteralPath $Path -Value $newLines -Encoding UTF8
}

function Get-RequiredNodeMajor {
    # Reads apps/agent/package.json's "engines.node" (e.g. ">=20") rather
    # than hardcoding it, so this script stays correct if that requirement
    # ever changes. Falls back to 20 (today's real requirement) if the file
    # can't be parsed for any reason.
    try {
        $pkg = Get-Content -Raw -LiteralPath $AgentPackageJsonPath | ConvertFrom-Json
        $nodeReq = $pkg.engines.node
        if ($nodeReq -match '(\d+)') { return [int]$Matches[1] }
    } catch {
        # fall through to default below
    }
    return 20
}

function Test-SumatraUsable {
    # The PowerShell-side twin of apps/agent/src/dependency-check.ts, run at
    # the same point in setup this script previously did a bare Test-Path.
    #
    # WHY NOT JUST Test-Path. A truncated download, a web page saved under an
    # .exe name (this script itself produced exactly that once - see the
    # 404-alias note above $SumatraPdfPinnedVersion), a build for the wrong
    # processor architecture, or an antivirus stub all pass Test-Path and then
    # fail at print time, hours later, on a real user's job. So this:
    #   1. resolves the path the same way src/config.ts does
    #      (PRINTIO_SUMATRA_PATH, else "SumatraPDF.exe" via PATH),
    #   2. requires the file to start with the "MZ" bytes every Windows .exe
    #      starts with, and
    #   3. actually STARTS the program and confirms Windows could load it.
    #
    # Conservative on purpose, exactly like the Node-side check: if the
    # process starts at all, this passes - the exit code, and even "it had to
    # be killed on a timeout", are treated as success, because they all prove
    # the one thing being tested. A false "it's broken" here would send
    # someone chasing a working install, which is worse than the bug this
    # closes.
    #
    # The probe argv cannot print anything: -silent suppresses the dialog a
    # GUI app would otherwise pop (which under a service account is a hang,
    # not an exit - which is also why a -h/-help probe was rejected), the PDF
    # path deliberately does not exist, and the queue name is randomized per
    # call so it can never be, or be mistaken for, a real print queue.
    $custom = $env:PRINTIO_SUMATRA_PATH
    $exe = $null
    if ($custom -and $custom.Trim() -ne "") {
        $exe = $custom.Trim()
        if (-not (Test-Path -LiteralPath $exe)) {
            return @{ Ok = $false; Detail = "PRINTIO_SUMATRA_PATH is set to '$exe', but no file exists there" }
        }
    } else {
        $cmd = Get-Command "SumatraPDF.exe" -ErrorAction SilentlyContinue
        if (-not $cmd) {
            return @{ Ok = $false; Detail = "SumatraPDF.exe was not found on PATH, and PRINTIO_SUMATRA_PATH is not set" }
        }
        $exe = $cmd.Source
    }

    # --- Is it actually an executable image? ---
    try {
        $stream = [System.IO.File]::OpenRead($exe)
        try {
            $header = New-Object byte[] 2
            $read = $stream.Read($header, 0, 2)
        } finally {
            $stream.Dispose()
        }
        if ($read -lt 2 -or $header[0] -ne 0x4D -or $header[1] -ne 0x5A) {
            return @{
                Ok = $false
                Path = $exe
                Detail = "'$exe' exists but is not a Windows program - it doesn't start with the 'MZ' bytes every .exe starts with. That's what a half-finished download, or a web page saved under an .exe name, looks like. Delete that file and install SumatraPDF again"
            }
        }
    } catch {
        return @{ Ok = $false; Path = $exe; Detail = "'$exe' exists but could not be read ($($_.Exception.Message))" }
    }

    # --- Can Windows actually start it? ---
    #
    # The probe file is placed directly on the system drive root and NEVER
    # created - it only has to be a path that doesn't exist. Deliberately not
    # under $env:TEMP: Windows PowerShell 5.1's Start-Process joins
    # -ArgumentList with plain spaces and does not quote the elements, so a
    # temp path containing a space (a username with a space in it, which is
    # completely ordinary) would silently split into two arguments. A
    # space-free path sidesteps that without hand-rolling quoting rules.
    $probeToken = [System.Guid]::NewGuid().ToString("N").Substring(0, 8)
    $systemDrive = $env:SystemDrive
    if (-not $systemDrive -or $systemDrive.Trim() -eq "") { $systemDrive = "C:" }
    $probePdf = "$systemDrive\printio-setup-probe-$probeToken-does-not-exist.pdf"
    $probeQueue = "printio-setup-probe-$probeToken"
    try {
        $proc = Start-Process -FilePath $exe `
            -ArgumentList @("-print-to", $probeQueue, "-silent", $probePdf) `
            -WindowStyle Hidden -PassThru
        # -PassThru can come back empty for a process that has already exited
        # by the time it returns. That is still a pass: it started, which is
        # the entire question this check asks.
        if ($null -eq $proc) {
            return @{ Ok = $true; Path = $exe; Detail = "$exe (started and exited immediately)" }
        }
        if (-not $proc.WaitForExit(10000)) {
            try { $proc.Kill() } catch { }
            return @{
                Ok = $true
                Path = $exe
                Detail = "$exe (started, but didn't exit within 10s so this check stopped it - it IS runnable, which is what's being verified)"
            }
        }
        return @{ Ok = $true; Path = $exe; Detail = $exe }
    } catch {
        return @{
            Ok = $false
            Path = $exe
            Detail = "Windows refused to run '$exe' ($($_.Exception.Message)). That usually means a corrupt download, a build for the wrong processor architecture, or antivirus blocking it"
        }
    }
}

function Test-PrintManagementAvailable {
    # docs/agent-install.md lists the PowerShell PrintManagement module as a
    # prerequisite, but nothing anywhere ever checked for it - it was
    # documentation only. Without it the Agent cannot enumerate queues
    # (heartbeat reports an empty queue list) and cannot identify or monitor
    # the spooler job it just submitted, so every job fails late with
    # "could not identify the resulting Windows spooler job" - the same
    # discovered-at-the-worst-moment shape as the SumatraPDF gap.
    #
    # Read-only, no admin rights, and checks for the COMMAND as well as the
    # module: what src/printer-manager.ts actually needs is `Get-Printer`
    # being callable, so a machine where that resolves through some other
    # module is honestly fine and must not be failed here.
    if (Get-Command "Get-Printer" -ErrorAction SilentlyContinue) {
        return @{ Ok = $true; Detail = "Get-Printer is available" }
    }
    if (Get-Module -ListAvailable -Name "PrintManagement" -ErrorAction SilentlyContinue) {
        return @{ Ok = $true; Detail = "the PrintManagement module is installed" }
    }
    return @{
        Ok = $false
        Detail = "neither the Get-Printer command nor the PrintManagement PowerShell module is available on this machine"
    }
}

function Get-ConfiguredPrinterQueues {
    # Also documentation-only until now ("at least one Windows printer queue
    # already configured"). Read-only and needs no admin rights.
    #
    # Wrapped in a hashtable rather than returning the array directly,
    # because PowerShell UNROLLS a returned array: `return @()` from a
    # function yields $null, which would make "this machine has zero
    # printers" indistinguishable from "the check itself couldn't run" - and
    # reporting the second as the first is exactly the kind of confidently
    # wrong message this pass is here to remove.
    try {
        $names = @(Get-Printer -ErrorAction Stop | ForEach-Object { $_.Name })
        return @{ Ok = $true; Queues = $names }
    } catch {
        return @{ Ok = $false; Queues = @(); Error = $_.Exception.Message }
    }
}

# A "/dl/rel/latest/..." alias was tried here first, on the assumption
# SumatraPDF's site published one - it does not: that path 404s, confirmed
# by a real run of this script in the field ("The remote server returned an
# error: (404) Not Found"), which silently left PRINTIO_SUMATRA_PATH
# pointing nowhere. Pinned to a real, confirmed-working release build
# instead - the exact "no-install" 64-bit exe SumatraPDF's own download page
# offers (same file a person downloads by hand, hence the filename below
# matching one already seen working on a real machine). This means it goes
# stale as new SumatraPDF versions ship; bump SumatraPdfPinnedVersion when
# that matters (an old-but-working build is still infinitely better than a
# broken auto-download, so this is not urgent to chase).
$SumatraPdfPinnedVersion = "3.6.1"
$SumatraPortableDownloadUrl = "https://www.sumatrapdfreader.org/dl/rel/$SumatraPdfPinnedVersion/SumatraPDF-$SumatraPdfPinnedVersion-64.exe"
$SumatraPortableInstallDir = "$env:ProgramData\Printio"
$SumatraPortableInstallPath = "$SumatraPortableInstallDir\SumatraPDF-64.exe"

function Install-SumatraPortable {
    # Downloads the portable build straight from SumatraPDF's own site - no
    # installer, no admin rights needed - and points PRINTIO_SUMATRA_PATH at
    # it, the same way the API URL prompt saves what it's asked for so this
    # is never asked again. Every failure here (no network, blocked by a
    # school firewall, etc.) is fail-open: this is a convenience, not a
    # requirement - the manual install instructions are still right there
    # for anyone this doesn't work for.
    Write-Info "Downloading SumatraPDF (portable, no install needed) from sumatrapdfreader.org..."
    try {
        New-Item -ItemType Directory -Path $SumatraPortableInstallDir -Force | Out-Null
        Invoke-WebRequest -Uri $SumatraPortableDownloadUrl -OutFile $SumatraPortableInstallPath -UseBasicParsing
        if (-not (Test-Path -LiteralPath $SumatraPortableInstallPath)) {
            throw "download reported success but the file isn't there"
        }
        # Verify what we just downloaded is a real, runnable program BEFORE
        # committing it to .env. The 404 incident noted above didn't fail
        # loudly - it wrote an HTML error page to disk under an .exe name and
        # then pointed PRINTIO_SUMATRA_PATH at it, so every later check said
        # "found!" and every print job failed. A download that isn't an
        # executable is deleted here rather than saved, so the fallback
        # instructions below are what the person actually sees.
        $previousSumatraPath = $env:PRINTIO_SUMATRA_PATH
        $env:PRINTIO_SUMATRA_PATH = $SumatraPortableInstallPath
        $verified = Test-SumatraUsable
        if (-not $verified.Ok) {
            $env:PRINTIO_SUMATRA_PATH = $previousSumatraPath
            Remove-Item -LiteralPath $SumatraPortableInstallPath -Force -ErrorAction SilentlyContinue
            Write-Warn "The download completed but what arrived isn't a working program: $($verified.Detail)."
            Write-Info "That file has been deleted rather than left behind pointing nowhere."
            return $false
        }
        Set-DotEnvValue -Path $EnvFilePath -Key "PRINTIO_SUMATRA_PATH" -Value $SumatraPortableInstallPath
        Write-Ok "SumatraPDF installed to $SumatraPortableInstallPath, verified runnable - saved to apps\agent\.env, so this won't be asked again."
        return $true
    } catch {
        Write-Warn "Couldn't download SumatraPDF automatically: $($_.Exception.Message)"
        return $false
    }
}

# ---------------------------------------------------------------------------
# Elevated re-launch path (install-service only)
#
# When option 2 is chosen and this window isn't already Administrator, we
# re-launch just this one step in a new, elevated PowerShell window (the
# standard Windows "click Yes on the UAC prompt" flow) rather than trying to
# silently escalate the whole interactive wizard. That elevated window
# re-loads .env itself (see Import-DotEnvFile above) and pauses on its own
# before closing, so its output is readable too.
# ---------------------------------------------------------------------------

function Invoke-InstallServiceFlow-Elevated {
    # Wrapped in its own try/finally (independent of the main flow's, since
    # this runs in a brand-new elevated process that never reaches the main
    # flow's try/finally below) so this window always pauses before closing,
    # success or failure alike - see the same rationale on the main flow.
    try {
        Import-DotEnvFile -Path $EnvFilePath
        Set-Location -LiteralPath $RepoRoot
        Write-Host ""
        Write-Host "Running with administrator rights now - installing the Windows Service..." -ForegroundColor Cyan
        $pnpmArgs = @("--filter", "@printio/agent", "install-service")
        & pnpm @pnpmArgs
        if ($LASTEXITCODE -ne 0) {
            Show-RunFailure "Installing the Windows Service failed (exit code $LASTEXITCODE)."
        } else {
            Write-Ok "The 'Printio Print Agent' Windows Service is installed and starting."
            Write-Info "It will now start automatically every time this machine boots."
        }
    } catch {
        Write-Host ""
        Write-Host "STOPPED: an unexpected error occurred: $($_.Exception.Message)" -ForegroundColor Red
    } finally {
        Write-Host ""
        Read-Host "Press Enter to close this window"
    }
}

if ($InstallServiceElevated) {
    Invoke-InstallServiceFlow-Elevated
    return
}

# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------

try {
    Write-Host "======================================================" -ForegroundColor Cyan
    Write-Host " Printio Print Agent - setup" -ForegroundColor Cyan
    Write-Host "======================================================" -ForegroundColor Cyan
    Write-Host "This script gets the Agent registered and running on this machine."
    Write-Host "It only runs the same commands documented in docs\agent-install.md -"
    Write-Host "it just asks you the couple of questions only you can answer."

    Set-Location -LiteralPath $RepoRoot

    # --- 0. Pull the latest version of this repo, if it's a real git clone --
    #
    # Means a bug fix to this very script (or to the Agent's own code) only
    # has to be pushed once - the next double-click of setup-agent.bat picks
    # it up automatically, instead of everyone needing to re-clone or
    # manually `git pull` themselves first. Any failure here (no network, a
    # detached HEAD, local commits that don't fast-forward) is a warning, not
    # a blocker - this machine's existing checkout is still perfectly usable
    # even if the update check itself doesn't succeed.
    #
    # ### THE RE-LAUNCH BELOW IS NOT COSMETIC - READ THIS BEFORE REMOVING IT
    #
    # PowerShell parses an ENTIRE .ps1 file into memory before it executes
    # the first line of it. So when the `git pull` below replaces THIS FILE
    # on disk, the process you are reading this in keeps running the OLD
    # code, start to finish. A fix pushed for this script therefore does not
    # take effect on the run that downloads it - only on the next one.
    #
    # That is not a theoretical concern; it produced a real, confusing
    # support round. A user was re-asked for their Printio cloud URL on every
    # single run (root cause: the script compared the saved value against a
    # hardcoded "example" URL that happened to be that deployment's real
    # one - fixed in 4a8e0f8). On their next run this step printed "Updated
    # to the latest version." and then, milliseconds later, the OLD parsed
    # copy asked for the URL again - so the honest conclusion from the
    # screen was "the fix didn't work", and a second bug hunt started for a
    # bug that had already been fixed.
    #
    # So: if the pull changed this file, re-launch it and let the NEW copy do
    # the work. The relaunched run is passed -Relaunched and skips this whole
    # step, which is what makes looping impossible.
    #
    # `--ff-only` rather than a bare `git pull`, matching
    # src/self-update.ts's reasoning: it either advances cleanly to what the
    # remote has or refuses and changes nothing - it can never invent a merge
    # commit in a checkout a school IT admin is not watching.
    if ($Relaunched) {
        Write-Step "Checking for updates"
        Write-Ok "Already done - this window was restarted by the update that just ran."
        $repoWasUpdated = $true
    } else {
        Write-Step "Checking for updates"
        $repoWasUpdated = $false
        if (Test-Path -LiteralPath (Join-Path $RepoRoot ".git")) {
            $gitCmd = Get-Command "git" -ErrorAction SilentlyContinue
            if ($gitCmd) {
                # Hashed BEFORE the pull so "did this script itself change?"
                # is answered by fact rather than by parsing git's output.
                $scriptHashBefore = $null
                try {
                    $scriptHashBefore = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
                } catch {
                    # Get-FileHash is unavailable/failed - handled below by
                    # telling the person to re-run rather than silently
                    # continuing on stale code.
                }
                try {
                    # $ErrorActionPreference is "Stop" for this whole script, and
                    # under "Stop" a native command's stderr captured via 2>&1
                    # becomes a TERMINATING NativeCommandError - git routes its
                    # ordinary progress chatter ("From github.com:...") to stderr,
                    # so this reported "couldn't check for updates" on essentially
                    # every run, even the successful ones. Relax the preference
                    # for just this one call and read $LASTEXITCODE instead, which
                    # is the actual success signal.
                    $previousEap = $ErrorActionPreference
                    $ErrorActionPreference = "Continue"
                    try {
                        $pullOutput = (& git pull --ff-only 2>&1 | ForEach-Object { $_.ToString() }) -join "`n"
                    } finally {
                        $ErrorActionPreference = $previousEap
                    }
                    if ($LASTEXITCODE -eq 0) {
                        # Both spellings: modern git says "Already up to date",
                        # older versions "Already up-to-date."
                        if ($pullOutput -match "Already up[ -]to[ -]date") {
                            Write-Ok "Already up to date."
                        } else {
                            $repoWasUpdated = $true
                            Write-Ok "Updated to the latest version."

                            $scriptHashAfter = $null
                            try {
                                $scriptHashAfter = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
                            } catch {
                                $scriptHashAfter = $null
                            }

                            if ($null -eq $scriptHashBefore -or $null -eq $scriptHashAfter) {
                                Write-Warn "Couldn't tell whether that update changed this setup script itself."
                                Write-Info "If anything below behaves like an already-fixed problem, close this window and double-click setup-agent.bat once more - a fresh window always runs the newly-downloaded version."
                            } elseif ($scriptHashAfter -ne $scriptHashBefore) {
                                Write-Warn "That update changed this setup script itself."
                                Write-Info "Windows had already loaded the previous version of it into memory, so this window is still running the OLD copy - restarting it now, automatically, so the update actually takes effect."
                                Write-Host ""
                                $relaunchArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath, "-Relaunched")
                                $previousEap = $ErrorActionPreference
                                $ErrorActionPreference = "Continue"
                                try {
                                    & powershell.exe @relaunchArgs
                                } finally {
                                    $ErrorActionPreference = $previousEap
                                }
                                # The relaunched copy ran the whole setup and
                                # did its own "Press Enter to close" pause -
                                # don't ask twice for the same window.
                                $script:SkipFinalPause = $true
                                return
                            }
                        }
                    } else {
                        Write-Warn "Couldn't check for updates (git pull --ff-only exited with code $LASTEXITCODE) - continuing with what's already on this machine, which may NOT include the latest fixes."
                        Write-Info $pullOutput
                        Write-Info "If you are chasing a problem that was supposed to be fixed already, this line is why: this machine is still on its own older copy of the code. Someone who knows git needs to look at the checkout in $RepoRoot."
                    }
                } catch {
                    Write-Warn "Couldn't check for updates ($($_.Exception.Message)) - continuing with what's already on this machine, which may NOT include the latest fixes."
                }
            } else {
                Write-Warn "git isn't on PATH, so this can't check for updates on its own - continuing with what's already on this machine. (git pull, run by hand from $RepoRoot, does the same thing.)"
            }
        } else {
            Write-Warn "This doesn't look like a git clone, so it can't check for updates on its own - continuing with what's already on this machine."
        }
    }

    # Say, out loud and unambiguously, exactly which version of the code this
    # run is about to use. Every one of the three "example placeholder
    # collides with a real value" bugs this script has had cost an extra
    # support round on the same question - "is that machine even running the
    # fixed code yet?" - which nothing on screen could answer. Now it can.
    try {
        $previousEap = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $headDescription = (& git log -1 --format="%h %cs %s" 2>&1 | ForEach-Object { $_.ToString() }) -join " "
            $headOk = ($LASTEXITCODE -eq 0)
        } finally {
            $ErrorActionPreference = $previousEap
        }
        if ($headOk -and $headDescription.Trim() -ne "") {
            Write-Info "Running code version: $($headDescription.Trim())"
        }
    } catch {
        # Purely informational - never worth interrupting setup for.
    }

    # --- 1. Node.js check (hard stop if missing/too old) --------------------

    Write-Step "Checking Node.js"
    $requiredNodeMajor = Get-RequiredNodeMajor
    $nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Warn "Node.js was not found on this machine."
        Show-StopMessage "Node.js $requiredNodeMajor+ is required, and this script cannot safely install it for you. Install it from https://nodejs.org/ (the 'LTS' download is fine), then double-click setup-agent.bat again."
        return
    }
    $nodeVersionRaw = (& node --version).Trim()
    $nodeMajor = 0
    if ($nodeVersionRaw -match '^v(\d+)\.') { $nodeMajor = [int]$Matches[1] }
    if ($nodeMajor -lt $requiredNodeMajor) {
        Write-Warn "Found Node.js $nodeVersionRaw, but $requiredNodeMajor+ is required."
        Show-StopMessage "Install a newer Node.js from https://nodejs.org/ (the 'LTS' download is fine) - this replaces the old version - then double-click setup-agent.bat again."
        return
    }
    Write-Ok "Node.js $nodeVersionRaw found (needs $requiredNodeMajor+)."

    # --- 2. Make sure a .env exists, then load it (no prompts yet) ----------
    #
    # Creating .env HERE, before anything else can write to it, is load
    # bearing. This used to live in step 4, after the SumatraPDF section -
    # and the SumatraPDF auto-download calls Set-DotEnvValue, which creates
    # the file if it's missing. So on a fresh machine that accepted the
    # download, .env came into existence containing one single
    # PRINTIO_SUMATRA_PATH line; step 4 then saw a .env already there and
    # skipped copying .env.example over, permanently losing every documented
    # default and every explanatory comment from the template for that
    # install. Same file, two writers, order-dependent result.
    #
    # Loading it before the summary below also means the SumatraPDF check
    # reflects a PRINTIO_SUMATRA_PATH the person may already have put in
    # .env by hand.

    if (-not (Test-Path -LiteralPath $EnvFilePath)) {
        if (Test-Path -LiteralPath $EnvExamplePath) {
            Copy-Item -LiteralPath $EnvExamplePath -Destination $EnvFilePath
        } else {
            New-Item -ItemType File -Path $EnvFilePath | Out-Null
        }
    }
    Import-DotEnvFile -Path $EnvFilePath

    # --- 3. "Before you start" summary ---------------------------------------

    Write-Step "Before you start - here's what this machine has"
    Write-Ok "Node.js $nodeVersionRaw"
    $sumatra = Test-SumatraUsable
    if ($sumatra.Ok) {
        Write-Ok "SumatraPDF works: $($sumatra.Detail)"
    } else {
        Write-Warn "SumatraPDF: $($sumatra.Detail)."
        Write-Info "The Agent needs this to actually send a PDF to the printer - without it, it will refuse to start at all (see docs\agent-install.md)."
        $installNow = Read-Host "Download it now automatically (portable, no admin rights needed)? [Y/n]"
        if ($installNow.Trim() -eq "" -or $installNow.Trim() -match "^[Yy]") {
            if (Install-SumatraPortable) {
                $sumatra = Test-SumatraUsable
            }
        }
        if (-not $sumatra.Ok) {
            Write-Info "Install it yourself from https://www.sumatrapdfreader.org/ , or set PRINTIO_SUMATRA_PATH in apps\agent\.env to its full path."
            Write-Info "(You can finish this setup without it, but the Agent will refuse to start until it's there - it checks this itself now, at startup, instead of letting a real print job be the thing that discovers it.)"
        }
    }

    # The PowerShell PrintManagement module and "at least one configured
    # printer queue" were both listed as prerequisites in
    # docs\agent-install.md and then never checked by anything, anywhere -
    # documentation standing in for a check. Both are cheap, read-only, and
    # need no admin rights, so there was no good reason for that. Neither is
    # a hard stop: they're advisory because a wrong "you have no printers"
    # verdict blocking a working install would be worse than the gap being
    # closed, and because the Agent legitimately registers and heartbeats
    # before any queue is set up.
    $printMgmt = Test-PrintManagementAvailable
    if ($printMgmt.Ok) {
        Write-Ok "Windows print management: $($printMgmt.Detail)."
    } else {
        Write-Warn "Windows print management: $($printMgmt.Detail)."
        Write-Info "The Agent uses Get-Printer/Get-PrintJob to find queues and to follow a job through the Windows spooler. Without them it can submit a print but never confirm it, so every job ends up reported as failed."
        Write-Info "This ships with Windows 10/11 and Windows Server - if it's genuinely missing, whoever manages this PC needs to look at why."
    }

    $queueResult = Get-ConfiguredPrinterQueues
    if (-not $queueResult.Ok) {
        Write-Warn "Windows print queues: couldn't be listed on this machine ($($queueResult.Error)), so this can't confirm there's one to print to."
        Write-Info "Make sure at least one printer queue is configured (docs\printer-setup.md) before relying on this for a real print job."
    } elseif ($queueResult.Queues.Count -eq 0) {
        Write-Warn "Windows print queues: none are configured on this machine."
        Write-Info "The Agent can still register and report in, but it has nothing to print to - and a printer_profiles row in Printio has to name a real queue on this machine."
        Write-Info "Add the printer and bake its finishing defaults into the queue first, following docs\printer-setup.md end to end."
    } else {
        Write-Ok "Windows print queues: $($queueResult.Queues.Count) configured ($($queueResult.Queues -join ', '))."
    }

    # --- 4. Make sure PRINTIO_API_URL is set (prompt once) ------------------

    Write-Step "Checking Printio cloud configuration"
    # A bare host (e.g. "printio.example.org", copy-pasted without the
    # "https://" the person was told about) parses fine as far as Read-Host
    # is concerned, gets saved verbatim, and then fails much later with a
    # confusing "PRINTIO_API_URL is not a valid URL" error out of the Agent
    # itself - by which point the person has already re-run the whole
    # script. Catch it here instead, where it's one Write-Info away from
    # just working.
    function Normalize-ApiUrl {
        param([string]$Url)
        if ($Url -notmatch "^[a-zA-Z][a-zA-Z0-9+.\-]*://") {
            Write-Info "Assuming https:// - saving this as https://$Url"
            return "https://$Url"
        }
        return $Url
    }

    # NOTE: this used to also re-ask whenever the saved value equaled one
    # specific hardcoded string (apps/agent/.env.example's own example
    # URL). That example happens to BE this deployment's real production
    # URL (whoever wrote the template used their own real domain as the
    # "example"), so for this org specifically, a correctly-saved real
    # value was indistinguishable from "still the unfilled example" - the
    # script re-asked for the URL on every single run, forever. The only
    # sound check is whether a value is present at all; matching against a
    # specific string is exactly what broke here.
    #
    # The two diagnostic lines below exist so that "why is it asking me
    # AGAIN?" can never again cost a round of guessing: they show what was
    # found in .env, and separately what this process will actually use
    # (which differs when a real Windows environment variable overrides the
    # file - a difference that is completely invisible otherwise, and would
    # look exactly like the script ignoring what it just saved).
    $envFileValues = Get-DotEnvValues -Path $EnvFilePath
    $apiUrlInFile = $null
    if ($envFileValues.Contains("PRINTIO_API_URL")) { $apiUrlInFile = $envFileValues["PRINTIO_API_URL"] }
    if ($null -eq $apiUrlInFile) {
        Write-Info "PRINTIO_API_URL in apps\agent\.env: (no active line for it)"
    } else {
        Write-Info "PRINTIO_API_URL in apps\agent\.env: '$apiUrlInFile'"
    }
    if ($null -eq $env:PRINTIO_API_URL) {
        Write-Info "PRINTIO_API_URL this run will use: (not set)"
    } else {
        Write-Info "PRINTIO_API_URL this run will use: '$($env:PRINTIO_API_URL)'"
        if ($null -ne $apiUrlInFile -and $env:PRINTIO_API_URL -ne $apiUrlInFile) {
            Write-Warn "Those two differ, which means a real Windows environment variable named PRINTIO_API_URL is overriding the .env file (that is by design - a real environment variable always wins - but it is why editing .env alone would not change anything here)."
        }
    }
    if ($env:PRINTIO_API_URL -and $env:PRINTIO_API_URL.Trim() -ne "") {
        $existing = Normalize-ApiUrl ($env:PRINTIO_API_URL.Trim())
        if ($existing -ne $env:PRINTIO_API_URL.Trim()) {
            Set-DotEnvValue -Path $EnvFilePath -Key "PRINTIO_API_URL" -Value $existing
            $env:PRINTIO_API_URL = $existing
        }
    }
    if ((-not $env:PRINTIO_API_URL) -or ($env:PRINTIO_API_URL.Trim() -eq "")) {
        Write-Info "This machine doesn't have a Printio cloud address configured yet."
        Write-Info "This is the web address of your organization's Printio cloud (ask your Printio administrator if you don't have it)."
        $apiUrl = Read-Host "Enter the Printio cloud URL, then press Enter"
        $apiUrl = $apiUrl.Trim()
        if ($apiUrl -eq "") {
            Show-StopMessage "A Printio cloud URL is required to continue. Double-click setup-agent.bat again when you have it."
            return
        }
        $apiUrl = Normalize-ApiUrl $apiUrl
        Set-DotEnvValue -Path $EnvFilePath -Key "PRINTIO_API_URL" -Value $apiUrl
        $env:PRINTIO_API_URL = $apiUrl
        Write-Ok "Saved - apps\agent\.env now has this, so you won't be asked again."
    } else {
        Write-Ok "PRINTIO_API_URL is set ($($env:PRINTIO_API_URL))."
    }

    # --- 5. pnpm check (with a corepack-based fallback) ----------------------

    Write-Step "Checking for pnpm (this repo's package manager)"
    if (-not (Get-Command "pnpm" -ErrorAction SilentlyContinue)) {
        Write-Warn "pnpm was not found."
        $corepackCmd = Get-Command "corepack" -ErrorAction SilentlyContinue
        if ($corepackCmd) {
            Write-Info "Node.js ships a built-in tool called Corepack that can turn on pnpm with a single command - trying that now (corepack enable)..."
            try {
                & corepack enable
                if ($LASTEXITCODE -ne 0) { throw "corepack enable exited with code $LASTEXITCODE" }
            } catch {
                Show-StopMessage "Could not enable pnpm via Corepack ($($_.Exception.Message)). Try running this same setup-agent.bat as Administrator (right-click it, 'Run as administrator'), or install pnpm yourself with: npm install -g pnpm"
                return
            }
            if (-not (Get-Command "pnpm" -ErrorAction SilentlyContinue)) {
                # corepack enable (or a manual `npm install -g pnpm` run in a
                # separate window per the message above) can write to PATH at
                # the Machine/User registry level without this already-running
                # process ever seeing the update - Get-Command only looks at
                # $env:Path as this process loaded it at startup. Re-read both
                # scopes and retry once before giving up and asking for a
                # restart, since that often avoids needing one at all.
                $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + `
                    [System.Environment]::GetEnvironmentVariable("Path", "User")
                if (-not (Get-Command "pnpm" -ErrorAction SilentlyContinue)) {
                    Show-StopMessage "Corepack ran, but pnpm still isn't available in this window. Close this window, double-click setup-agent.bat again (a fresh window picks up the change), or install pnpm yourself with: npm install -g pnpm"
                    return
                }
            }
            Write-Ok "pnpm is now available (via Corepack)."
        } else {
            Show-StopMessage "This repo uses pnpm to install its dependencies, and neither pnpm nor Corepack (the tool that enables it) was found. Install pnpm with: npm install -g pnpm - then double-click setup-agent.bat again."
            return
        }
    } else {
        Write-Ok "pnpm found."
    }

    # --- 6. Install dependencies if not already installed --------------------

    Write-Step "Checking dependencies"
    $rootNodeModules = Join-Path $RepoRoot "node_modules"
    $agentNodeModules = Join-Path $AgentDir "node_modules"
    # A "node_modules exists" check alone is not enough right after step 0
    # actually pulled new commits: those commits may have added or bumped a
    # dependency, and skipping the install then leaves the Agent running
    # against the old dependency tree - failing at import time with an error
    # that says nothing about the real cause. Re-install whenever the checkout
    # just changed; it's a fast no-op when nothing in the lockfile did.
    if ((Test-Path -LiteralPath $rootNodeModules) -and (Test-Path -LiteralPath $agentNodeModules) -and (-not $repoWasUpdated)) {
        Write-Ok "Dependencies already installed."
    } else {
        if ($repoWasUpdated) {
            Write-Info "This checkout was just updated, so dependencies are being re-checked with 'pnpm install'..."
        }
        Write-Info "Installing dependencies with 'pnpm install' - this can take a few minutes the first time..."
        & pnpm install
        if ($LASTEXITCODE -ne 0) {
            Show-StopMessage "'pnpm install' failed (exit code $LASTEXITCODE)."
            return
        }
        Write-Ok "Dependencies installed."
    }

    # --- 7. Registration check ------------------------------------------------

    Write-Step "Checking whether this Agent is already registered"
    $localStoragePath = Get-LocalStoragePath
    $credentialsPath = Join-Path $localStoragePath "agent-credentials.json"
    $alreadyRegistered = Test-Path -LiteralPath $credentialsPath

    # A bare Test-Path here was another "the check is cheaper than the thing
    # it stands for" trap. src/secure-storage.ts's loadCredentials() treats an
    # unparseable credentials file as NOT registered and tells you to run
    # `register` again - but this script, seeing the file exist, reported
    # "Already registered" and skipped the only prompt that could have gotten
    # you out of it. The result was a dead end reachable from a routine
    # double-click: setup says registered, the Agent says it isn't, and the
    # script offers no way forward.
    #
    # A full check would have to decrypt the file the same way the Agent does
    # (DPAPI, LocalMachine scope). What is cheap and worth doing here is the
    # structural half: if it isn't even well-formed JSON with a storage
    # version this repo writes, it is definitively unusable, so move it aside
    # and ask for an enrollment code like a fresh install would.
    if ($alreadyRegistered) {
        $credentialsLookValid = $false
        try {
            $storedCredentials = Get-Content -Raw -LiteralPath $credentialsPath | ConvertFrom-Json
            $credentialsLookValid = ($null -ne $storedCredentials) -and ($null -ne $storedCredentials.version) -and ($storedCredentials.version -ne "")
        } catch {
            $credentialsLookValid = $false
        }
        if (-not $credentialsLookValid) {
            $setAside = "$credentialsPath.unusable-" + (Get-Date -Format "yyyyMMdd-HHmmss")
            Write-Warn "There is a stored credentials file at $credentialsPath, but it isn't readable as a credentials file - the Agent would refuse to use it and report itself as not registered."
            try {
                Move-Item -LiteralPath $credentialsPath -Destination $setAside
                Write-Info "Moved it aside to $setAside (nothing was deleted) so this can register cleanly."
            } catch {
                Write-Warn "Couldn't move it aside ($($_.Exception.Message)) - registering below may fail until that file is removed by hand."
            }
            $alreadyRegistered = $false
        }
    }

    if ($alreadyRegistered) {
        Write-Ok "Already registered (found stored credentials at $credentialsPath)."
    } else {
        Write-Info "Not registered yet."
        Write-Info "Paste the enrollment code your Printio administrator gave you, then press Enter:"
        $enrollmentCode = Read-Host "Enrollment code"
        $enrollmentCode = $enrollmentCode.Trim()
        if ($enrollmentCode -eq "") {
            Show-StopMessage "An enrollment code is required to register. Double-click setup-agent.bat again when you have one."
            return
        }
        Write-Info "Registering..."
        $pnpmArgs = @("--filter", "@printio/agent", "register", "--", "--code=$enrollmentCode")
        & pnpm @pnpmArgs
        if ($LASTEXITCODE -ne 0) {
            Show-RunFailure "Registration failed (exit code $LASTEXITCODE)."
            return
        }
        Write-Ok "Registered successfully."
    }

    # --- 8. Run now, or install as a service? --------------------------------

    Write-Step "Run now to test, or install as a permanent service?"
    if (-not $sumatra.Ok) {
        # The Agent runs this same check itself on startup now and refuses to
        # start if it fails (src/dependency-check.ts), so say so here rather
        # than letting either option below fail in a way that looks like a
        # different problem - option 1 as an immediate non-zero exit, option
        # 2 as a service that installs fine and then restart-loops.
        Write-Warn "SumatraPDF still isn't usable on this machine, and the Agent checks that itself on startup - so it will refuse to start, whichever option you pick below."
        Write-Info "Fix that first (scroll up for what was wrong), then double-click setup-agent.bat again."
    }
    Write-Info "1 = Run now to test it. This window becomes the running Agent - watch it work, and closing this window stops it."
    Write-Info "2 = Install as a permanent Windows service that starts automatically (recommended once testing with option 1 looks right)."

    $choice = ""
    while ($choice -ne "1" -and $choice -ne "2") {
        $choice = (Read-Host "Run now to test it (press 1), or install as a permanent Windows service that starts automatically (press 2)?").Trim()
        if ($choice -ne "1" -and $choice -ne "2") {
            Write-Warn "Please type 1 or 2."
        }
    }

    if ($choice -eq "1") {
        Write-Host ""
        Write-Host "Starting the Agent now. This window IS the running Agent - leave it open." -ForegroundColor Cyan
        Write-Host "Press Ctrl+C to stop it, or just close this window." -ForegroundColor Cyan
        Write-Host ""
        $pnpmArgs = @("--filter", "@printio/agent", "start")
        & pnpm @pnpmArgs
        $startExit = $LASTEXITCODE
        if ($startExit -ne 0) {
            Show-RunFailure "The Agent exited unexpectedly (exit code $startExit)."
            if (Test-Path -LiteralPath $credentialsPath) {
                # The one dead end this script cannot detect up front (see the
                # registration check above): a credentials file that parses
                # fine but can no longer be DECRYPTED on this machine - which
                # is what a re-image, a restored disk image, or a Windows
                # reinstall leaves behind. The Agent then says "No agent
                # credentials found" and every future run of this script says
                # "already registered", forever. Say how to break the loop.
                Write-Warn "If the message above says the Agent has no credentials, its stored credential can no longer be read on this machine (common after re-imaging or restoring this PC)."
                Write-Info "To fix that: ask your Printio administrator to Rotate this Agent in Admin -> Agents for a fresh enrollment code, delete $credentialsPath, then double-click setup-agent.bat again - it will ask for the new code."
            }
        } else {
            Write-Host ""
            Write-Ok "The Agent stopped cleanly."
        }
    } else {
        if (Test-IsElevated) {
            Write-Info "This window already has administrator rights - installing the service directly."
            $pnpmArgs = @("--filter", "@printio/agent", "install-service")
            & pnpm @pnpmArgs
            if ($LASTEXITCODE -ne 0) {
                Show-RunFailure "Installing the Windows Service failed (exit code $LASTEXITCODE)."
            } else {
                Write-Ok "The 'Printio Print Agent' Windows Service is installed and starting."
                Write-Info "It will now start automatically every time this machine boots."
            }
        } else {
            Write-Info "Installing as a Windows Service needs administrator rights."
            Write-Info "Windows will show a permission prompt (User Account Control) - click Yes to allow it."
            try {
                $elevatedArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath, "-InstallServiceElevated")
                $proc = Start-Process -FilePath "powershell.exe" -ArgumentList $elevatedArgs -Verb "RunAs" -Wait -PassThru
                if ($proc.ExitCode -ne 0) {
                    Write-Warn "The elevated window reported exit code $($proc.ExitCode) - check the output in that window for the specific error."
                } else {
                    Write-Ok "Done - see the elevated window that opened for the result."
                }
            } catch {
                Write-Host ""
                Write-Host "STOPPED: Administrator permission was not granted (the prompt was cancelled or blocked), so the service was not installed." -ForegroundColor Red
                Write-Warn "To try again: right-click setup-agent.bat, choose 'Run as administrator', then choose option 2."
            }
        }
    }

    Write-Host ""
    Write-Host "Done." -ForegroundColor Cyan
} catch {
    Write-Host ""
    Write-Host "STOPPED: an unexpected error occurred: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "This is not a normal Agent error message - it's this setup script itself hitting something it didn't expect." -ForegroundColor Yellow
} finally {
    # Skipped only when this run handed the whole job over to a relaunched
    # copy of itself (step 0), which already did this pause in this very
    # window - asking twice would just look broken.
    if (-not $script:SkipFinalPause) {
        Write-Host ""
        Read-Host "Press Enter to close this window"
    }
}
