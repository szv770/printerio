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

.NOTES
  Called via setup-agent.bat, which is what makes this double-click-able
  (Windows opens a bare .ps1 in a text editor instead of running it).
#>

param(
    # Internal flag only - used when this script re-launches itself elevated
    # (as Administrator) to run `install-service`. Not meant to be passed by
    # hand; see Invoke-InstallServiceFlow below.
    [switch]$InstallServiceElevated
)

$ErrorActionPreference = "Stop"

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

function Import-DotEnvFile {
    # Loads KEY=VALUE lines from a .env file into this process's environment
    # (never overriding a variable that's already set - e.g. a real Windows
    # environment variable someone configured takes priority over .env).
    #
    # apps/agent/src/index.ts loads .env itself now (same never-override
    # behavior), so this is no longer required to make `pnpm --filter
    # @printio/agent ...` itself see these values - but THIS SCRIPT still
    # needs them loaded into its own PowerShell process to make its own
    # decisions (the "before you start" SumatraPDF check, and whether to
    # prompt for PRINTIO_API_URL both read $env:... directly, before any
    # Node process ever starts).
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    foreach ($rawLine in (Get-Content -LiteralPath $Path)) {
        $line = $rawLine.Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { continue }
        $idx = $line.IndexOf("=")
        if ($idx -lt 1) { continue }
        $key = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()
        if ($value.Length -ge 2) {
            $isDoubleQuoted = $value.StartsWith('"') -and $value.EndsWith('"')
            $isSingleQuoted = $value.StartsWith("'") -and $value.EndsWith("'")
            if ($isDoubleQuoted -or $isSingleQuoted) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        if (-not (Test-Path "Env:\$key")) {
            Set-Item -Path "Env:\$key" -Value $value
        }
    }
}

function Set-DotEnvValue {
    # Writes (or updates) a single KEY=VALUE line in a .env file, preserving
    # every other line as-is. Used so the Printio cloud URL, once typed in,
    # is only ever asked for once.
    param([string]$Path, [string]$Key, [string]$Value)
    $lines = @()
    if (Test-Path -LiteralPath $Path) { $lines = @(Get-Content -LiteralPath $Path) }
    $found = $false
    $newLines = @()
    foreach ($line in $lines) {
        if ($line -match "^\s*#?\s*$([regex]::Escape($Key))\s*=") {
            $newLines += "$Key=$Value"
            $found = $true
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

function Test-SumatraFound {
    # Same lookup order the Agent itself uses (src/config.ts): an explicit
    # PRINTIO_SUMATRA_PATH env var first, then PATH.
    $custom = $env:PRINTIO_SUMATRA_PATH
    if ($custom -and $custom.Trim() -ne "") {
        if (Test-Path -LiteralPath $custom) {
            return @{ Found = $true; Detail = $custom }
        }
        return @{ Found = $false; Detail = "PRINTIO_SUMATRA_PATH is set to '$custom', but no file exists there" }
    }
    $cmd = Get-Command "SumatraPDF.exe" -ErrorAction SilentlyContinue
    if ($cmd) { return @{ Found = $true; Detail = $cmd.Source } }
    return @{ Found = $false; Detail = "SumatraPDF.exe was not found on PATH, and PRINTIO_SUMATRA_PATH is not set" }
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
        Set-DotEnvValue -Path $EnvFilePath -Key "PRINTIO_SUMATRA_PATH" -Value $SumatraPortableInstallPath
        $env:PRINTIO_SUMATRA_PATH = $SumatraPortableInstallPath
        Write-Ok "SumatraPDF installed to $SumatraPortableInstallPath - saved to apps\agent\.env, so this won't be asked again."
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
    # manually `git pull` themselves first. Safe by construction: a plain
    # `git pull` only ever fast-forwards or fails outright (it never
    # discards local changes), and any failure here (no network, a detached
    # HEAD, local commits that don't fast-forward) is a warning, not a
    # blocker - this machine's existing checkout is still perfectly usable
    # even if the update check itself doesn't succeed.
    Write-Step "Checking for updates"
    $repoWasUpdated = $false
    if (Test-Path -LiteralPath (Join-Path $RepoRoot ".git")) {
        $gitCmd = Get-Command "git" -ErrorAction SilentlyContinue
        if ($gitCmd) {
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
                    $pullOutput = (& git pull 2>&1 | ForEach-Object { $_.ToString() }) -join "`n"
                } finally {
                    $ErrorActionPreference = $previousEap
                }
                if ($LASTEXITCODE -eq 0) {
                    if ($pullOutput -match "Already up to date") {
                        Write-Ok "Already up to date."
                    } else {
                        $repoWasUpdated = $true
                        Write-Ok "Updated to the latest version."
                    }
                } else {
                    Write-Warn "Couldn't check for updates (git pull exited with code $LASTEXITCODE) - continuing with what's already on this machine."
                    Write-Info $pullOutput
                }
            } catch {
                Write-Warn "Couldn't check for updates ($($_.Exception.Message)) - continuing with what's already on this machine."
            }
        } else {
            Write-Warn "git isn't on PATH, so this can't check for updates on its own - continuing with what's already on this machine. (git pull, run by hand from $RepoRoot, does the same thing.)"
        }
    } else {
        Write-Warn "This doesn't look like a git clone, so it can't check for updates on its own - continuing with what's already on this machine."
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

    # --- 2. Load whatever .env already exists (no prompts yet) --------------
    # Done before the summary below so the SumatraPDF check reflects a
    # PRINTIO_SUMATRA_PATH the person may have already put in .env.

    Import-DotEnvFile -Path $EnvFilePath

    # --- 3. "Before you start" summary ---------------------------------------

    Write-Step "Before you start - here's what this machine has"
    Write-Ok "Node.js $nodeVersionRaw"
    $sumatra = Test-SumatraFound
    if ($sumatra.Found) {
        Write-Ok "SumatraPDF found: $($sumatra.Detail)"
    } else {
        Write-Warn "SumatraPDF: $($sumatra.Detail)."
        Write-Info "The Agent needs this to actually send a PDF to the printer - without it, every print job will fail."
        $installNow = Read-Host "Download it now automatically (portable, no admin rights needed)? [Y/n]"
        if ($installNow.Trim() -eq "" -or $installNow.Trim() -match "^[Yy]") {
            if (Install-SumatraPortable) {
                $sumatra = Test-SumatraFound
            }
        }
        if (-not $sumatra.Found) {
            Write-Info "Install it yourself from https://www.sumatrapdfreader.org/ , or set PRINTIO_SUMATRA_PATH in apps\agent\.env to its full path."
            Write-Info "(You can keep going without it, but printing itself will fail until it's there.)"
        }
    }
    Write-Warn "Windows print queue: this script has no way to check for one."
    Write-Info "Make sure at least one printer queue is already configured for this Agent (docs\printer-setup.md) before relying on it for a real print job."

    # --- 4. Make sure PRINTIO_API_URL is set (create/prompt once) -----------

    Write-Step "Checking Printio cloud configuration"
    if (-not (Test-Path -LiteralPath $EnvFilePath)) {
        if (Test-Path -LiteralPath $EnvExamplePath) {
            Copy-Item -LiteralPath $EnvExamplePath -Destination $EnvFilePath
        } else {
            New-Item -ItemType File -Path $EnvFilePath | Out-Null
        }
        Import-DotEnvFile -Path $EnvFilePath
    }
    # A bare host (e.g. "printio.szvtech.org", copy-pasted without the
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

    $placeholderApiUrl = "https://printio.szvtech.org"
    if ($env:PRINTIO_API_URL -and $env:PRINTIO_API_URL.Trim() -ne "") {
        $existing = Normalize-ApiUrl ($env:PRINTIO_API_URL.Trim())
        if ($existing -ne $env:PRINTIO_API_URL.Trim()) {
            Set-DotEnvValue -Path $EnvFilePath -Key "PRINTIO_API_URL" -Value $existing
            $env:PRINTIO_API_URL = $existing
        }
    }
    if ((-not $env:PRINTIO_API_URL) -or ($env:PRINTIO_API_URL.Trim() -eq "") -or ($env:PRINTIO_API_URL.Trim() -eq $placeholderApiUrl)) {
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
    Write-Host ""
    Read-Host "Press Enter to close this window"
}
