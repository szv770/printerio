<#
.SYNOPSIS
  One-click setup/launcher for the PrintOS Print Agent, for a non-technical
  first-time install on a Windows machine.

.DESCRIPTION
  This is a thin wrapper around the Agent's real CLI (apps/agent/src/index.ts:
  `register`, `start`, `install-service`), invoked exactly as documented in
  apps/agent/README.md and docs/agent-install.md, via
  `pnpm --filter @printos/agent ...`. It adds NO new Agent functionality - it
  only automates the sequence of typed commands a manual install otherwise
  requires, and prompts for the two pieces of information only a human can
  supply (the enrollment code, and this organization's PrintOS cloud URL).

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
    # PRINTOS_LOCAL_STORAGE_PATH handling exactly, so "is this Agent already
    # registered?" is checked against the real place the Agent itself will
    # look, not a guess.
    if ($env:PRINTOS_LOCAL_STORAGE_PATH -and $env:PRINTOS_LOCAL_STORAGE_PATH.Trim() -ne "") {
        return $env:PRINTOS_LOCAL_STORAGE_PATH.Trim()
    }
    $programData = $env:ProgramData
    if (-not $programData -or $programData.Trim() -eq "") { $programData = "C:\ProgramData" }
    return Join-Path $programData "PrintOS\Agent"
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
    # This exists because nothing in apps/agent/src actually loads a .env
    # file automatically (confirmed by reading src/config.ts - it reads only
    # from process.env). docs/agent-install.md's "Copy .env.example to .env"
    # step relies on *something* putting those values into the process
    # environment before `register`/`start`/`install-service` run; for a
    # manual `pnpm --filter @printos/agent start` that's on the person
    # running it (e.g. a tool like `dotenv-cli`, or setting real Windows env
    # vars). This launcher does it itself so double-clicking "just works".
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
    # every other line as-is. Used so the PrintOS cloud URL, once typed in,
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
    # PRINTOS_SUMATRA_PATH env var first, then PATH. This is a check, not a
    # fix - if it's missing, we only warn (see task scope: SumatraPDF must
    # already be installed per the prerequisites).
    $custom = $env:PRINTOS_SUMATRA_PATH
    if ($custom -and $custom.Trim() -ne "") {
        if (Test-Path -LiteralPath $custom) {
            return @{ Found = $true; Detail = $custom }
        }
        return @{ Found = $false; Detail = "PRINTOS_SUMATRA_PATH is set to '$custom', but no file exists there" }
    }
    $cmd = Get-Command "SumatraPDF.exe" -ErrorAction SilentlyContinue
    if ($cmd) { return @{ Found = $true; Detail = $cmd.Source } }
    return @{ Found = $false; Detail = "SumatraPDF.exe was not found on PATH, and PRINTOS_SUMATRA_PATH is not set" }
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
        & pnpm @("--filter", "@printos/agent", "install-service")
        if ($LASTEXITCODE -ne 0) {
            Show-RunFailure "Installing the Windows Service failed (exit code $LASTEXITCODE)."
        } else {
            Write-Ok "The 'PrintOS Print Agent' Windows Service is installed and starting."
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
    Write-Host " PrintOS Print Agent - setup" -ForegroundColor Cyan
    Write-Host "======================================================" -ForegroundColor Cyan
    Write-Host "This script gets the Agent registered and running on this machine."
    Write-Host "It only runs the same commands documented in docs\agent-install.md -"
    Write-Host "it just asks you the couple of questions only you can answer."

    Set-Location -LiteralPath $RepoRoot

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
    # PRINTOS_SUMATRA_PATH the person may have already put in .env.

    Import-DotEnvFile -Path $EnvFilePath

    # --- 3. "Before you start" summary ---------------------------------------

    Write-Step "Before you start - here's what this machine has"
    Write-Ok "Node.js $nodeVersionRaw"
    $sumatra = Test-SumatraFound
    if ($sumatra.Found) {
        Write-Ok "SumatraPDF found: $($sumatra.Detail)"
    } else {
        Write-Warn "SumatraPDF: $($sumatra.Detail)."
        Write-Info "Install it from https://www.sumatrapdfreader.org/ , or set PRINTOS_SUMATRA_PATH in apps\agent\.env to its full path."
        Write-Info "(You can keep going without it, but printing itself will fail until it's there.)"
    }
    Write-Warn "Windows print queue: this script has no way to check for one."
    Write-Info "Make sure at least one printer queue is already configured for this Agent (docs\printer-setup.md) before relying on it for a real print job."

    # --- 4. Make sure PRINTOS_API_URL is set (create/prompt once) -----------

    Write-Step "Checking PrintOS cloud configuration"
    if (-not (Test-Path -LiteralPath $EnvFilePath)) {
        if (Test-Path -LiteralPath $EnvExamplePath) {
            Copy-Item -LiteralPath $EnvExamplePath -Destination $EnvFilePath
        } else {
            New-Item -ItemType File -Path $EnvFilePath | Out-Null
        }
        Import-DotEnvFile -Path $EnvFilePath
    }
    $placeholderApiUrl = "https://printos.example.org"
    if ((-not $env:PRINTOS_API_URL) -or ($env:PRINTOS_API_URL.Trim() -eq "") -or ($env:PRINTOS_API_URL.Trim() -eq $placeholderApiUrl)) {
        Write-Info "This machine doesn't have a PrintOS cloud address configured yet."
        Write-Info "This is the web address of your organization's PrintOS cloud (ask your PrintOS administrator if you don't have it)."
        $apiUrl = Read-Host "Enter the PrintOS cloud URL, then press Enter"
        $apiUrl = $apiUrl.Trim()
        if ($apiUrl -eq "") {
            Show-StopMessage "A PrintOS cloud URL is required to continue. Double-click setup-agent.bat again when you have it."
            return
        }
        Set-DotEnvValue -Path $EnvFilePath -Key "PRINTOS_API_URL" -Value $apiUrl
        $env:PRINTOS_API_URL = $apiUrl
        Write-Ok "Saved - apps\agent\.env now has this, so you won't be asked again."
    } else {
        Write-Ok "PRINTOS_API_URL is set ($($env:PRINTOS_API_URL))."
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
                Show-StopMessage "Corepack ran, but pnpm still isn't available in this window. Close this window, double-click setup-agent.bat again (a fresh window picks up the change), or install pnpm yourself with: npm install -g pnpm"
                return
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
    if ((Test-Path -LiteralPath $rootNodeModules) -and (Test-Path -LiteralPath $agentNodeModules)) {
        Write-Ok "Dependencies already installed."
    } else {
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
        Write-Info "Paste the enrollment code your PrintOS administrator gave you, then press Enter:"
        $enrollmentCode = Read-Host "Enrollment code"
        $enrollmentCode = $enrollmentCode.Trim()
        if ($enrollmentCode -eq "") {
            Show-StopMessage "An enrollment code is required to register. Double-click setup-agent.bat again when you have one."
            return
        }
        Write-Info "Registering..."
        & pnpm @("--filter", "@printos/agent", "register", "--", "--code=$enrollmentCode")
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
        & pnpm @("--filter", "@printos/agent", "start")
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
            & pnpm @("--filter", "@printos/agent", "install-service")
            if ($LASTEXITCODE -ne 0) {
                Show-RunFailure "Installing the Windows Service failed (exit code $LASTEXITCODE)."
            } else {
                Write-Ok "The 'PrintOS Print Agent' Windows Service is installed and starting."
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
