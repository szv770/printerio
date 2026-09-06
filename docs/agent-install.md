# Windows Print Agent — install & operate

This is an operational runbook: what to do, in what order, and why. `apps/agent/README.md`
(maintained alongside the agent code) is the source of truth for exact CLI flags, config
variables, and internals — this document is the sequence a real install actually follows,
cross-referencing that README rather than duplicating it.

See [architecture.md](./architecture.md) sec 4 (agent identity/auth), sec 11
(spooler monitoring), sec 12 (remote commands), sec 17 (offline/failure recovery)
and [agent-api.md](./agent-api.md) for the full protocol this runbook is putting
into practice.

**Before you start**: nothing in `apps/agent` has been run against a real Windows machine or
a real printer — it was built and unit-tested in a sandboxed Linux container (see
`apps/agent/README.md`'s "Testing status" section for exactly what is and isn't verified).
Console-mode testing (§3 below) and the physical validation checklist
(`apps/agent/README.md` → "Physical validation checklist") are not optional steps to skim —
they're how the first real gaps in this get found.

## Prerequisites

- Windows 10/11 or Windows Server, with a user account that can run a background
  service and has permission to manage the relevant printer queues.
- Node.js 20+ LTS installed on that machine.
- [SumatraPDF](https://www.sumatrapdfreader.org/) installed, with `SumatraPDF.exe`
  either on `PATH` or its full path set via `PRINTOS_SUMATRA_PATH` (the Agent
  invokes it directly by path — see architecture.md sec 10 — so either works).
- The PowerShell **PrintManagement module** available to `powershell.exe` (built
  into modern Windows) — this is how the Agent discovers queues and reads/cancels
  spooler jobs (sec 11).
- At least one Windows printer queue already configured, with its finishing
  defaults (duplex, staple, booklet, punch) baked in as that queue's Printing
  Defaults — this is **not** something the Agent or PrintOS software does; it's a
  one-time driver-GUI task. Do this **before** installing the Agent, following
  [printer-setup.md](./printer-setup.md) end to end, so there's something real
  for the Agent to discover and print to on first run.
- Outbound HTTPS connectivity from this machine to the PrintOS cloud app's
  domain (the Agent only ever makes outbound calls — see agent-api.md "polling,
  not a persistent connection" — so no inbound firewall rule is needed; see
  architecture.md sec 1 for why this specific shape is what makes an Agent
  workable on a network where the printer segment itself is otherwise isolated).

## The fast path: one script

If this is a first-time setup and you'd rather not type a sequence of `pnpm` commands by
hand, once the repo is on the Windows machine (cloned or copied over — see §2 for how) and
Node.js 20+ and SumatraPDF are installed per the prerequisites above:

1. Open the `printos` folder in File Explorer.
2. Go to `apps\agent\scripts` and double-click **`setup-agent.bat`**.
3. Answer the couple of plain-English prompts it asks (your organization's PrintOS cloud
   URL the first time, then your enrollment code), then choose **1** to run the Agent in
   this window as a quick test, or **2** to install it as a permanent Windows service.

It checks Node.js/SumatraPDF and prints what it finds, installs dependencies with `pnpm
install` if they aren't already there (enabling `pnpm` itself via Corepack first if
needed), registers the Agent if it isn't registered yet, and then does exactly `pnpm
--filter @printos/agent start` or `install-service` — the same commands documented in §3
and §5 below, just without you having to type them. On any failure it explains what went
wrong in plain language and where to look for more detail, and it always waits for you to
press Enter before the window closes, so an error is never just a window that flashes and
disappears. It's safe to double-click again later — a second run detects what's already
done and skips straight to "run now or install as a service?".

**This is a convenience wrapper around the exact same CLI documented in the numbered steps
below, nothing more** — read those steps (and `apps/agent/README.md`) if you want to
understand what it's actually doing, if it fails and you need to troubleshoot by hand, or
if you're scripting/CI-ing this instead of running it interactively. Like the rest of this
Agent, `apps/agent/scripts/setup-agent.ps1` was written and reviewed in a sandboxed Linux
container with no Windows machine to run it against — treat it as reviewed, not verified,
until it's actually been double-clicked on a real Windows machine.

## 1. Obtain an enrollment code

An `org_admin` creates the Agent's row in the PrintOS dashboard (Admin → Agents
→ "Register new agent") *before* the Agent software runs anywhere. This creates
an `agents` row with `status = 'pending'` and displays a one-time enrollment
code, valid 24h (architecture.md sec 4, agent-api.md `POST
/api/agents/register`). Copy it somewhere you can paste it into the Agent's
registration step below — it is shown once and the server never displays it
again after redemption.

## 2. Get the code onto the machine and install dependencies

On the Windows machine, with Node.js 20+ already installed:

```powershell
git clone <this repo> printos
cd printos
pnpm install               # workspace install (pnpm@10.33.0, pinned in package.json)
```

(A packaged/standalone build that doesn't require the full monorepo checkout — e.g. a zipped
`dist/` + `node_modules` — is not built yet; see the root README's phase table. Cloning the
repo and running from the workspace is the current path.)

## 3. Register, then run in console mode first

```powershell
pnpm --filter @printos/agent register -- --code=<enrollmentCode>
```

Exchanges the code for a device id + secret (`POST /api/agents/register`) and persists them
to local secure storage — on Windows, DPAPI-encrypted (`LocalMachine` scope) via an embedded
PowerShell helper; see `apps/agent/README.md` "Secure storage" for the fallback path and why
`LocalMachine` scope was chosen. The plaintext secret is shown once by the cloud and never
retrievable again — if it's lost, rotate it (§6) rather than trying to recover it.

**Run as a console app first**, to actually see what's happening:

```powershell
pnpm --filter @printos/agent start
```

Watch the log output directly and confirm: it heartbeats successfully (`POST
/api/agents/heartbeat`), it discovers the printer queue(s) configured on this machine, and
(once you have a real test job — see [testing.md](./testing.md)) it claims, downloads, and
prints a job end to end. Console mode is where a misconfigured queue name, a missing
SumatraPDF path, or a bad device secret shows up immediately, in front of you — don't skip
straight to service mode. Ctrl+C sends SIGINT; the Agent finishes its current poll cycle and
exits cleanly.

## 4. Configuration

Copy `apps/agent/.env.example` to `.env` (git-ignored) — the Agent loads it automatically on
startup, console mode or installed Windows Service alike, and never overrides a variable
that's already set in the real environment. For production you can instead (or additionally)
set these as real Windows environment variables (System Properties → Environment Variables,
or `node-windows`'s service `env` option) if you'd rather not keep a `.env` file on disk at
all — both approaches work and compose. The only required variable is `PRINTOS_API_URL`; everything else
(`PRINTOS_LOCAL_STORAGE_PATH`, `PRINTOS_LOG_LEVEL`, `PRINTOS_POLL_INTERVAL_SECONDS`,
`PRINTOS_SUMATRA_PATH`, `PRINTOS_PRINT_FIT_MODE`, etc.) has a documented default — see the
`.env.example` file itself for the full list with rationale. `PRINTOS_AGENT_ID`/
`PRINTOS_AGENT_SECRET` are normally **not** set by hand at all — `register` (§3) persists them
to secure storage and `start` loads them from there automatically; setting them here is only
for advanced/CI scenarios that deliberately bypass secure storage.

## 5. Install as a Windows service

Once console-mode testing (§3) passes:

```powershell
pnpm --filter @printos/agent install-service
```

Requires administrator privileges. Installs and starts a service named "PrintOS Print Agent"
(via [`node-windows`](https://github.com/coreybutler/node-windows)) and best-effort configures
the Service Control Manager to restart it automatically on crash/exit (`sc.exe failure ...` —
this is what makes the `RESTART_AGENT_SERVICE` remote command, architecture.md sec 12,
actually effective). The service runs the same entry point non-interactively and starts
automatically on machine boot.

To remove it: `pnpm --filter @printos/agent uninstall-service`.

**This step specifically is untested on a real Windows machine** — the actual Windows Service
Control Manager integration cannot be exercised in the sandbox this agent was built in (see
`apps/agent/README.md` "Testing status"). Confirm it once, deliberately, on real hardware:
service installs and starts, survives a machine reboot, and actually restarts itself after a
forced `taskkill` of its process.

## 6. Logs

Written to `<PRINTOS_LOCAL_STORAGE_PATH>/logs/agent-<YYYY-MM-DD>.log` (JSON lines, one per day;
default path `C:\ProgramData\PrintOS\Agent\logs` on Windows) as well as stdout/console in
console mode. Expect heartbeat success/failure, the full job claim → download → print
lifecycle (mirroring the `print_job_events` audit trail on the cloud side, architecture.md sec
13), SumatraPDF invocation exit codes/stdout/stderr (sec 10), and any remote command executed
(sec 12). Secrets (device secret, bearer header, signed download URLs) are always redacted —
never search these logs expecting to find one. If you installed as a service and the log file
is empty, check Windows Event Log next — a service that fails to start at all won't have
written its own log file yet.

## 7. Rotating or revoking a device credential

From the PrintOS dashboard (Admin → Agents), an `org_admin` can, per Agent:

- **Rotate**: issues a brand-new device secret; the old one stops working immediately
  (architecture.md sec 4). Do this if a device secret may have leaked, or after re-imaging the
  Windows machine. Re-run `pnpm --filter @printos/agent register -- --code=<newCode>` on the
  machine with the new enrollment code the dashboard shows after rotating.
- **Revoke** (disable): sets the Agent's status so no further authenticated call succeeds,
  without issuing a replacement. Use this when decommissioning a machine, or if an Agent should
  stop operating entirely (e.g. its queue no longer exists).

Both actions are audit-logged (`audit_logs` table).

## 8. Uninstalling

1. From the dashboard, **revoke** the Agent's credential first (§7), so a stray running copy
   can't keep claiming jobs after you've decided to remove it.
2. `pnpm --filter @printos/agent uninstall-service` (if installed as a service).
3. Remove the Agent's local data directory (`PRINTOS_LOCAL_STORAGE_PATH` —
   `C:\ProgramData\PrintOS\Agent` by default: device secret, any queued/in-flight job files,
   logs) if you want a clean removal rather than leaving stale local state behind.
4. If the physical printer/queues are also being decommissioned: `printer_profiles.agent_id`
   is a foreign key with `on delete restrict` (`supabase/migrations/0002_printing_tables.sql`)
   — you cannot delete the `agents` row while profiles still reference it. Reassign or remove
   those profiles first if the printer is truly going away, or just leave the revoked Agent row
   in place as a historical record if the printer/queues persist under a different Agent.

## 9. Before trusting a real job to this

Work through `apps/agent/README.md`'s "Physical validation checklist" in full (14 concrete
scenarios: simplex/duplex/color/multi-copy/odd paper sizes, printer-offline, paper-out
mid-job, cancellation, Agent restart mid-print, network loss, and more) against this real
machine and printer before relying on it for real print jobs. It exists precisely because
nothing on this list has been exercised outside a sandboxed Linux container yet.
