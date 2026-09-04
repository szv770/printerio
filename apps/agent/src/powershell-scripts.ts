/**
 * Embedded PowerShell script bodies.
 *
 * Design choice: every script that takes parameters (a printer queue name, a
 * job id) is invoked via `powershell.exe -File <path> -Name value ...` - i.e.
 * genuine argv parameters bound by PowerShell's own `param()` block - rather
 * than interpolating those values into a `-Command "..."` string. This is
 * deliberately stronger than "spawn with an argv array" alone: even with
 * spawn (no OS shell involved), a `-Command` string is still *parsed as
 * PowerShell source* by powershell.exe itself, so a queue name containing a
 * stray quote/semicolon could still break out of a hand-built command string.
 * Using `-File` + real parameters sidesteps that entirely - the queue
 * name/job id are never re-interpreted as script text, the same way argv[]
 * to any other CLI tool isn't. See docs/architecture.md sec 10-11 and
 * ps-runner.ts.
 *
 * Scripts are written out to a temp .ps1 file on first use (ps-runner.ts)
 * rather than shipped as separate asset files, so there is nothing extra to
 * copy during `pnpm build`.
 *
 * Every script sets $ErrorActionPreference = 'Stop' and wraps its body in a
 * try/catch that always emits exactly one line of compact JSON on stdout
 * (either the result or `{ ok:false / found:false, error: "..." }`), so the
 * Node side has one parse path regardless of success/failure.
 */

/** No parameters - takes no untrusted input, so -Command would also be safe, but -File keeps every script the same shape. */
export const DISCOVER_PRINTERS_PS1 = `
$ErrorActionPreference = 'Stop'
try {
  $printers = @(Get-Printer | ForEach-Object {
    $p = $_
    [ordered]@{
      windowsQueueName = $p.Name
      driverName       = $p.DriverName
      portName         = $p.PortName
      printerStatus    = $p.PrinterStatus.ToString()
      shared           = [bool]$p.Shared
    }
  })
  [ordered]@{ ok = $true; printers = $printers } | ConvertTo-Json -Compress -Depth 4
} catch {
  [ordered]@{ ok = $false; printers = @(); error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

/**
 * Lists jobs on ONE named queue (mandatory -PrinterName - there is no
 * "all printers" mode). Used only transiently, right before/after invoking
 * SumatraPDF, to identify by diff which newly-appeared job id is the one we
 * just submitted (SumatraPDF does not itself report the spooler job id it
 * was assigned). This is not the "scoped read" used for ongoing
 * monitoring/cancel - see GET_PRINT_JOB_PS1 / REMOVE_PRINT_JOB_PS1 for that,
 * which additionally require the specific job id.
 */
export const LIST_PRINT_JOBS_PS1 = `
param(
  [Parameter(Mandatory = $true)][string]$PrinterName
)
$ErrorActionPreference = 'Stop'
try {
  $jobs = @(Get-PrintJob -PrinterName $PrinterName -ErrorAction Stop | ForEach-Object {
    [ordered]@{
      id            = [int]$_.Id
      documentName  = $_.DocumentName
      submittedTime = $_.SubmittedTime.ToString('o')
    }
  })
  [ordered]@{ ok = $true; jobs = $jobs } | ConvertTo-Json -Compress -Depth 3
} catch {
  [ordered]@{ ok = $false; jobs = @(); error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

/** Mandatory -PrinterName AND -JobId together - never an ID-only lookup (docs/architecture.md sec 11). */
export const GET_PRINT_JOB_PS1 = `
param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][int]$JobId
)
$ErrorActionPreference = 'Stop'
try {
  $job = Get-PrintJob -PrinterName $PrinterName -ID $JobId -ErrorAction Stop
  [ordered]@{
    ok            = $true
    found         = $true
    id            = [int]$job.Id
    jobStatus     = $job.JobStatus.ToString()
    documentName  = $job.DocumentName
    totalPages    = $job.TotalPages
    pagesPrinted  = $job.PagesPrinted
  } | ConvertTo-Json -Compress
} catch {
  [ordered]@{ ok = $true; found = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

/** Mandatory -PrinterName AND -JobId together - never an ID-only lookup (docs/architecture.md sec 11). */
export const REMOVE_PRINT_JOB_PS1 = `
param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][int]$JobId
)
$ErrorActionPreference = 'Stop'
try {
  Remove-PrintJob -PrinterName $PrinterName -ID $JobId -ErrorAction Stop
  [ordered]@{ ok = $true } | ConvertTo-Json -Compress
} catch {
  [ordered]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

/**
 * Whole-machine operation (docs/architecture.md sec 11-12): restarting the
 * Spooler service affects every queue on the machine. Only ever invoked as
 * the explicit RESTART_PRINT_QUEUE remote command, never as routine per-job
 * recovery.
 */
export const RESTART_SPOOLER_PS1 = `
$ErrorActionPreference = 'Stop'
try {
  Restart-Service -Name Spooler -Force -ErrorAction Stop
  [ordered]@{ ok = $true } | ConvertTo-Json -Compress
} catch {
  [ordered]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

/**
 * DPAPI protect/unprotect helpers for secure-storage.ts. Plaintext is read
 * from stdin (never a CLI argument - argv is visible to other processes on
 * the machine via the process list, stdin is not) and the result is written
 * to stdout only. LocalMachine scope (not CurrentUser) is used deliberately:
 * the Windows Service typically runs as LocalSystem or a dedicated service
 * account rather than an interactive user, and LocalMachine-scoped DPAPI
 * blobs can be unprotected by any process on the same machine regardless of
 * which account is running - see secure-storage.ts and README "Secure
 * storage" for the full threat-model tradeoff this implies.
 */
export const DPAPI_PROTECT_PS1 = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
try {
  $plainText = [Console]::In.ReadToEnd()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($plainText)
  $protected = [System.Security.Cryptography.ProtectedData]::Protect(
    $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
  [Console]::Out.Write([Convert]::ToBase64String($protected))
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
`;

export const DPAPI_UNPROTECT_PS1 = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
try {
  $b64 = [Console]::In.ReadToEnd().Trim()
  $bytes = [Convert]::FromBase64String($b64)
  $unprotected = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
  [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($unprotected))
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
`;
