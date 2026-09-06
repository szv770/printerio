# @printos/agent - PrintOS Print Agent

The on-premises Windows Print Agent for PrintOS. It runs on a Windows machine that has
Windows print queues configured for your printer(s), polls the PrintOS cloud for jobs it's
allowed to print, downloads and submits them to the correct local queue via SumatraPDF, and
reports what happened back to the cloud. See `docs/architecture.md` (secs 4, 9-13, 17) and
`docs/agent-api.md` for the full design this implements.

**It never receives the Supabase service-role key.** It authenticates as itself with a device
secret it obtains once via `register` (docs/architecture.md sec 4).

## Testing status - READ THIS FIRST

This package was written and validated in a sandboxed Linux container with **no Windows
machine, no real printer, and no PowerShell**. What that means concretely:

**Validated in this sandbox** (via `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm lint`,
and manual end-to-end smoke runs against a local mock HTTP server standing in for the cloud):
- The full `register -> start` flow: exchanging an enrollment code, persisting credentials
  (fallback encrypted-file path - see "Secure storage" below), loading them back on `start`,
  and the heartbeat/claim/download/status polling loop's request shaping (auth header, retry/
  backoff, the documented request/response bodies).
- Graceful degradation when `powershell.exe` doesn't exist (confirmed live: printer discovery
  logs a warning and reports an empty queue list rather than crashing).
- The print-settings token builder (allow-list only, rejects hostile input), spooler job
  status classification, the local job-queue's persistence/atomic-write/reconciliation-helper
  logic, and the command allow-list/CLEAR_AGENT_TEMP_FILES scoping - all unit tested with
  mocked I/O (`test/*.test.ts`).
- That `pnpm start` / the Windows Service launcher can actually resolve and run
  `@printos/shared` at runtime (see "A real bug this surfaced" below) - confirmed by running
  the compiled/uncompiled entrypoints directly in this sandbox.

**NOT validated - genuinely untested, best-effort only:**
- Anything that actually talks to Windows: `Get-Printer`/`Get-PrinterPort`, `Get-PrintJob`/
  `Remove-PrintJob`, `Restart-Service Spooler`, DPAPI (`ProtectedData`) via PowerShell.
- SumatraPDF invocation against a real print queue/driver, and whether SumatraPDF's spooler
  `DocumentName` really does match the filename we pass it (used to identify our own spooler
  job id - see `spooler-monitor.ts` `findNewJobId`).
- `node-windows` service install/uninstall/failure-recovery (`sc.exe failure`) - it does
  install cleanly as an npm dependency here (verified: pure JS, no native build step, resolves
  to `node-windows@1.0.0-beta.8` per the lockfile), but the actual Windows Service Control
  Manager integration cannot be exercised on Linux.
- Real multi-hundred-page PDFs, real Kyocera KX driver behavior, real paper-out/offline/
  cancel scenarios.

Treat every PowerShell script and the Windows-Service code path as reviewed-but-unverified.
**Do not consider this agent production-ready until the physical validation checklist below
has been run, in full, against a real Windows machine and a real printer.**

### A real bug this surfaced (fixed, worth knowing about)

`packages/shared/package.json` ships its TypeScript source directly with no build step
(`"exports": {".": "./src/index.ts"}`) - fine under `tsx`/Vite/Vitest (which all transform
`.ts` on the fly and are how `pnpm dev`/`pnpm test` already worked), but **plain `node
dist/index.js` cannot import it at all**: Node's own ESM resolver has no idea what TypeScript
is and throws `ERR_MODULE_NOT_FOUND` trying to resolve `@printos/shared`'s own internal
`./job-state.js` relative import (which only has a `.ts` file on disk). This was caught by
actually running the built output in this sandbox, not by typechecking (`tsc` doesn't catch
it - it's a pure runtime module-resolution mismatch).

The fix, entirely inside `apps/agent`: `pnpm start` runs `tsx src/index.ts start` (not
`node dist/index.js`), and the installed Windows Service runs through
`service-launcher.mjs` (see that file's comments), which registers `tsx`'s loader
programmatically via `tsx/esm/api` before importing `src/index.ts` - required because
node-windows forks the target script with `child_process.fork(script, args, { env })` and no
`execArgv`, so a `--import tsx` flag on the outer service process is not inherited by the
forked script (verified against the installed `node-windows@1.0.0-beta.8` source). Both paths
were exercised directly in this sandbox and work. `pnpm build`/`tsc` still exist and still
matter (type-safety, a real compiled artifact), they're just not what actually executes.

## Prerequisites

- **Node.js 20+** on the Windows machine that will run the agent.
- **SumatraPDF** installed, with `SumatraPDF.exe` either on `PATH` or at a path you set via
  `PRINTOS_SUMATRA_PATH`.
- **Windows print queues already configured**, one per finishing profile, per
  `docs/printer-setup.md` - this agent only ever *selects* a pre-configured queue
  (`windowsQueueName`, resolved by the cloud); it never programs staple/booklet/punch itself
  (docs/architecture.md sec 9).
- The **PowerShell PrintManagement module** (built into modern Windows) available to
  `powershell.exe`.
- An **enrollment code** for this agent, created by an org_admin in the PrintOS dashboard
  (docs/architecture.md sec 4, docs/agent-api.md `POST /api/agents/register`).

## Configuration

Environment variables - see `.env.example` for the full list with defaults. The required one
is `PRINTOS_API_URL`; everything else has a sane default. `PRINTOS_AGENT_ID`/
`PRINTOS_AGENT_SECRET` are normally *not* set by hand - see "Register" below.

## Install & build

```
pnpm install               # from the repo root (workspace install)
pnpm --filter @printos/agent build       # tsc typecheck + compiled output in dist/ (see note above: not what actually runs)
pnpm --filter @printos/agent typecheck
pnpm --filter @printos/agent test
pnpm --filter @printos/agent lint
```

## Register (one-time)

```
pnpm --filter @printos/agent register -- --code=<enrollmentCode>
# or, from apps/agent: pnpm register -- --code=<enrollmentCode>
```

(For a first-time interactive setup on Windows, `scripts/setup-agent.bat` double-clicks
through this and the steps below via plain-English prompts instead — see
`docs/agent-install.md` "The fast path: one script". The commands above are still what it
runs under the hood, and are what you want for scripting/CI.)

This exchanges the code for a device id + secret (`docs/agent-api.md POST
/api/agents/register`) and persists them to local secure storage (see below). The plaintext
secret is never logged and is only ever shown once, by the cloud, at registration time - this
CLI does not print it either.

## Running

(`scripts/setup-agent.bat` offers both of the below as a plain-English "1 or 2?" prompt
instead of typed commands — see "Register" above.)

**Console/foreground mode** (development, or a quick manual run):

```
pnpm --filter @printos/agent start
```

Runs `tsx src/index.ts start` in the foreground. Ctrl+C sends SIGINT and the agent shuts down
after finishing its current poll cycle.

**As a Windows Service** (production):

```
pnpm --filter @printos/agent install-service
```

Installs and starts a service named "PrintOS Print Agent", and best-effort configures the
Service Control Manager to restart it automatically on crash/exit (`sc.exe failure ...` -
this is what makes the `RESTART_AGENT_SERVICE` remote command actually effective). Requires
administrative privileges (node-windows shells out to Windows service APIs). **Untested on a
real Windows machine - see "Testing status" above.**

To remove it:

```
pnpm --filter @printos/agent uninstall-service
```

## Poll loop and outage backoff

Heartbeat, remote commands, and claimable jobs are all polled on the same cycle, every
`PRINTOS_POLL_INTERVAL_SECONDS` (default 15s) - see `src/orchestrator.ts` `runOnce()`. Each of
those three calls already gets its own exponential-backoff retry inside `src/cloud-client.ts`
(`sendWithRetry`, `MAX_RETRIES=4`) before it's considered failed for that cycle; that per-request
layer is unrelated to and unaffected by everything below.

On top of that, the outer loop tracks **consecutive full-cycle failures** - a cycle where
heartbeat, commands, *and* claimable-jobs *all* failed to reach the cloud (a single flaky
endpoint while the other two succeed doesn't count; see `CycleOutcome` in `orchestrator.ts`).
Each additional such cycle doubles the next sleep, capped at `PRINTOS_MAX_POLL_INTERVAL_SECONDS`
(default 300s/5 minutes), and a single fully-successful cycle snaps the interval straight back to
`PRINTOS_POLL_INTERVAL_SECONDS` - no gradual ramp-down. This exists so a sustained cloud outage
doesn't have every Agent across every org hammering the backend at the same fixed 15s cadence for
the whole outage (flagged by an earlier infra-scalability review). A healthy Agent's cadence is
completely unaffected - the backoff only ever engages once a cycle has actually failed entirely.

The agent also adds a **one-time startup jitter** - a random extra 0-`PRINTOS_POLL_INTERVAL_
SECONDS` delay before its very first sleep only (never before the first heartbeat, which still
fires immediately on start) - so a fleet of Agents that boot in lockstep (e.g. a nightly Group
Policy reboot restarting many machines at once) doesn't stay phase-locked on every later cycle
too. For the default 15s interval this is a minor one-time cost (up to 15s added to the gap
between the first and second poll only); it's a deliberate tradeoff, not a bug, if you notice the
second poll arriving later than expected.

The doubling/capping math is a pure function (`computeNextPollDelayMs` in `orchestrator.ts`),
unit tested in `test/orchestrator.test.ts` the same way `job-queue.ts`'s helpers and
`commands.ts`'s allow-list are.

## Logs

Written to `<PRINTOS_LOCAL_STORAGE_PATH>/logs/agent-<YYYY-MM-DD>.log` (JSON lines, one per
day) as well as stdout/console. Secrets (device secret, bearer header, signed download URLs)
are always redacted - see `src/logger.ts` `redact()`/`redactBearerHeader()`. Downloaded PDF
*contents* are never logged; only local file paths and sizes are.

## Secure storage

The device secret is persisted so `start` doesn't require re-running `register` every time
(`src/secure-storage.ts`):

- **On Windows:** encrypted via the Windows Data Protection API (DPAPI,
  `System.Security.Cryptography.ProtectedData`), `LocalMachine`-scoped, invoked through a
  small embedded PowerShell helper (plaintext piped over stdin, never a CLI argument - argv is
  visible to other processes on the machine, stdin is not). `LocalMachine` scope (rather than
  `CurrentUser`) is a deliberate tradeoff: the Windows Service typically runs as `LocalSystem`
  or a dedicated service account rather than an interactive user, and a `LocalMachine`-scoped
  blob can be decrypted by any sufficiently-privileged process on the same machine regardless
  of which account is running - i.e. it protects against the credentials file being copied to
  a *different* machine, not against another admin-level process on the *same* machine. This
  is untested on a real Windows box - see "Testing status".
- **Fallback** (non-Windows, or if the DPAPI helper fails for any reason): an
  AES-256-GCM-encrypted local file, keyed by a random key file written alongside it with
  `0o600` permissions. This is meaningfully weaker - anyone who can read both files as the
  same OS user can decrypt the secret - and every code path that uses it logs a loud warning.
  **This fallback exists so the agent still works somewhere to develop/test against; it is
  not a substitute for running in production on Windows.**

We deliberately did not take a dependency on `keytar` (a native module, largely unmaintained,
requiring a working native build toolchain per platform - a poor fit here) - DPAPI via
PowerShell needs no native compilation and is Microsoft's own documented mechanism for this
exact use case.

## What this agent will not do (by design, not by omission)

- It will never program stapling/booklet/punch finishing via SumatraPDF flags or raw
  PJL/PRESCRIBE injection. It only ever picks which pre-configured Windows queue
  (`windowsQueueName`, resolved by the cloud) to print to - see `docs/architecture.md` sec 9
  and `docs/printer-setup.md`.
- It will never report a job `completed` beyond what `docs/known-limitations.md` documents:
  `submitted_to_spooler` means the spooler accepted the job; `completed` means it was observed
  leaving the spooler queue cleanly (`JOB_STATUS_PRINTED`-equivalent) - **neither is proof the
  printer physically produced pages.** If the agent cannot identify which Windows spooler job
  its own submission became, it reports `failed` with a clear message rather than guessing at
  success (`orchestrator.ts`).
- It will never look up or cancel a print job by ID alone. Every spooler read/cancel passes
  the exact queue name and job id together (`spooler-monitor.ts`) - see `docs/architecture.md`
  sec 11.
- It accepts exactly five remote commands - `REFRESH_PRINTER_STATUS`, `CANCEL_PRINT_JOB`,
  `RESTART_PRINT_QUEUE`, `RESTART_AGENT_SERVICE`, `CLEAR_AGENT_TEMP_FILES` - via a fixed
  `switch` (`commands.ts`). There is no code path that accepts or evaluates an arbitrary
  string/command from the cloud.
- It never builds a PowerShell or SumatraPDF command by string concatenation with any
  variable input. Every external process is invoked via `spawn`/`fork` with an argv array;
  parameterized PowerShell calls use `-File <script> -Name value` (real PowerShell `param()`
  binding) rather than a hand-built `-Command` string - see `src/powershell-scripts.ts` for
  why that's meaningfully safer than it might first look.

## A documented gap between the abstract spec and the concrete contract

`docs/architecture.md` sec 17 describes the agent "reconciling state with the cloud on
reconnect (comparing its local job records against the cloud's view...)". `job-queue.ts`
exports and unit-tests a `moreAdvancedState()` helper for exactly this kind of comparison, but
**`docs/agent-api.md` has no endpoint for the agent to fetch a specific job's current
cloud-side status** (only `claimable`, `claim`, `download-url`, and `status` [write-only]
exist - there is no `GET .../jobs/:jobId`). So today, `moreAdvancedState()` is exercised only by its
own unit test, and startup reconciliation (`orchestrator.ts` `recoverInFlightJobs`) instead
follows a more conservative rule that doesn't need such an endpoint: resume monitoring a job
this agent can still verify against the real Windows spooler (queue name + spooler job id
recorded locally), and report `failed` (letting the cloud's lease-expiry/retry mechanism
recover it - sec 13) for anything earlier than that. This is not a bug so much as a gap
between the spec's abstract description and the literal contract in `agent-api.md` - flagging
it per this task's instructions rather than unilaterally adding an endpoint to that doc.

## Physical validation checklist

**Nothing in this list has been run against real hardware.** Once you have a real Windows
machine with SumatraPDF installed and at least one configured print queue pointed at a real
Kyocera device (or any printer, for the non-Kyocera-specific cases), work through this list
before trusting this agent with real jobs. For each case, confirm both what the *printer*
physically did and what the *PrintOS dashboard* shows for the job (they should agree, modulo
the documented `submitted_to_spooler` vs `completed` distinction).

1. **1-page black & white job.** Confirm it prints, and the job reaches `completed` (or
   `submitted_to_spooler` if your port monitor doesn't support true end-of-job - see
   `docs/known-limitations.md`) without manual intervention.
2. **10-page black & white job.** Same, plus confirm page count/paper handling look right.
3. **Duplex job.** Confirm the physical output is actually double-sided, not just that the
   agent sent the `duplex` token.
4. **Color job.** Confirm actual color output on a queue whose driver defaults support it.
5. **Multiple copies (e.g. 5).** Confirm the `Nx`/`collate` tokens produce 5 correctly
   collated copies, not 5 interleaved copies of everything.
6. **11x17 (tabloid/ledger) paper.** Confirm the `paper=` token actually selects that tray/
   size on this driver - printer-profile paper-size names are admin-declared, not verified
   (`docs/architecture.md` sec 9), so this is exactly the kind of mismatch that needs a real
   check.
7. **Mixed page sizes within one PDF.** Confirm behavior is at least sane (no crash, no
   silently-dropped pages) - this is explicitly out of scope for automatic detection
   (`docs/architecture.md` sec 5) but the agent still has to survive it.
8. **A stapled-queue job and a booklet-queue job.** Confirm the *queue selection* mechanism
   works end to end (right queue chosen for the profile) and that the finishing itself
   happens (staple/saddle-stitch) - per design, this is entirely the queue's baked-in Printing
   Defaults (`docs/printer-setup.md`), not anything this agent's print-settings string
   controls; if it doesn't happen, the queue's defaults are misconfigured, not the agent.
9. **A large job** (100+ pages, or a large file size) - confirm the streamed download
   (`orchestrator.ts` `downloadJobFile`) and SumatraPDF's default timeout are both adequate;
   tune `PRINTOS_SPOOLER_TIMEOUT_SECONDS` if needed.
10. **Printer offline** at claim/print time - confirm the job is reported `failed` with a
    clear message, the process does not crash, and a subsequent claimable-jobs poll still
    works normally.
11. **Paper-out mid-job** - confirm `spooler-monitor.ts` classifies this as a failure
    (`JOB_STATUS_PAPEROUT` or equivalent) rather than hanging until the timeout.
12. **Job cancellation** via the dashboard while the agent is mid-print or waiting in the
    spooler - confirm `CANCEL_PRINT_JOB` actually removes it from the Windows queue
    (`Remove-PrintJob`, scoped to the exact queue+id the agent itself recorded) and the
    physical printer stops/never starts that job.
13. **Agent restart** while a job is `printing`/`submitted_to_spooler` - confirm
    `recoverInFlightJobs()` resumes monitoring the real spooler job and reports an honest
    final status, rather than either losing track of it or double-submitting it.
14. **Internet disconnected** - confirm the agent keeps running against jobs already in
    flight, heartbeat/claim/status calls fail gracefully (logged, retried with backoff, never
    a crash), and once connectivity returns, normal polling resumes without manual
    intervention.

Also worth confirming once, separately: `install-service`/`uninstall-service` on a real
Windows machine (administrator privileges required), and that the DPAPI credential-storage
path actually engages (log line should say "DPAPI, LocalMachine-scoped", not the fallback
warning) rather than silently falling back.
