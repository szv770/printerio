# Windows Print Agent — install & operate

This is an operational runbook: what to do, in what order, and why. For the exact
CLI flags, subcommands, and environment variables `apps/agent` accepts, defer to
**`apps/agent/README.md`**, maintained alongside the agent code — this document
does not invent exact command syntax it hasn't verified, since `apps/agent` has
no application code checked into this repository yet (see the root
[README.md](../README.md) "Current status & next phase"). What follows is the
sequence and reasoning; treat `apps/agent/README.md` as the source of truth for
literal commands once it exists.

See [architecture.md](./architecture.md) sec 4 (agent identity/auth), sec 11
(spooler monitoring), sec 12 (remote commands), sec 17 (offline/failure recovery)
and [agent-api.md](./agent-api.md) for the full protocol this runbook is putting
into practice.

## Prerequisites

- Windows 10/11 or Windows Server, with a user account that can run a background
  service and has permission to manage the relevant printer queues.
- Node.js 20+ LTS installed on that machine.
- [SumatraPDF](https://www.sumatrapdfreader.org/) installed, with `SumatraPDF.exe`
  either on `PATH` or its full path available to configure explicitly (the Agent
  invokes it directly by path — see architecture.md sec 10 — so either works).
- At least one Windows printer queue already configured, with its finishing
  defaults (duplex, staple, booklet, punch) baked in as that queue's Printing
  Defaults — this is **not** something the Agent or PrintOS software does; it's a
  one-time driver-GUI task. Do this **before** installing the Agent, following
  [printer-setup.md](./printer-setup.md) end to end, so there's something real
  for the Agent to discover and print to on first run.
- Outbound HTTPS connectivity from this machine to the PrintOS cloud app's
  domain (the Agent only ever makes outbound calls — see agent-api.md "polling,
  not a persistent connection" — so no inbound firewall rule is needed).

## 1. Obtain an enrollment code

An `org_admin` creates the Agent's row in the PrintOS dashboard (Admin →
Agents → New Agent, or equivalent) *before* the Agent software runs anywhere.
This creates an `agents` row with `status = 'pending'` and displays a one-time
enrollment code (architecture.md sec 4, agent-api.md `POST
/api/agents/register`). Copy that code somewhere you can paste it into the
Agent's registration step — it is shown once and the server never displays it
again after redemption.

## 2. Install dependencies and run in register mode

On the Windows machine, with Node.js 20+ already installed:

1. Get the `apps/agent` code onto the machine (clone the repo, or deploy a built
   artifact — whichever this project's release process ends up using; see
   `apps/agent/README.md` once it exists).
2. Install dependencies (`pnpm install` from the workspace root, or however
   `apps/agent/README.md` documents running it standalone on a machine that
   isn't the full monorepo checkout).
3. Run the Agent's registration step, passing the enrollment code from step 1.
   This exchanges the code for a long-lived device secret
   (`POST /api/agents/register` — agent-api.md), which the Agent then persists
   locally (exact storage location and format: see `apps/agent/README.md`). The
   plaintext device secret is returned exactly once by the server and is never
   retrievable again — if it's lost, an admin must rotate it (see §5) rather
   than trying to recover it.

## 3. Console app vs Windows service

**Run as a console app first**, for testing: start the Agent in the foreground
on the Windows machine, watch its log output directly, and confirm it
successfully heartbeats (`POST /api/agents/heartbeat` — agent-api.md), discovers
the printer queue(s) configured on that machine, and (once you have a real test
job — see [testing.md](./testing.md)) claims and prints a job end to end. Do not
skip straight to service mode; console mode is where you catch a misconfigured
queue name, a missing SumatraPDF path, or a bad device secret quickly, with
output right in front of you.

**Install as a Windows service** once console-mode testing passes, so the Agent
survives reboots and doesn't depend on a logged-in interactive session. This
project uses [`node-windows`](https://github.com/coreybutler/node-windows) (or
an equivalent Node-based Windows service wrapper) for this — the exact install
command/subcommand is `apps/agent`'s responsibility to document precisely
(`apps/agent/README.md`). Conceptually: the service wrapper registers a Windows
service that runs the same Agent entry point non-interactively, restarts it on
crash, and starts it automatically on machine boot.

## 4. Logs

Confirm where `apps/agent` writes its logs (again, `apps/agent/README.md` is
authoritative) — expect at minimum: heartbeat success/failure, job claim/
download/print lifecycle events (mirroring the `print_job_events` audit trail
on the cloud side per architecture.md sec 13), SumatraPDF invocation exit
codes/stdout/stderr (architecture.md sec 10), and any remote command executed
(architecture.md sec 12). When running as a service rather than a console app,
Windows Event Log or a log file under the Agent's own install/data directory
are the two conventional places to look — check both if one is empty.

## 5. Rotating or revoking a device credential

From the PrintOS dashboard, an `org_admin` can, per Agent:

- **Rotate**: issues a brand-new device secret; the old one stops working
  immediately (architecture.md sec 4). Do this if a device secret may have
  leaked, or after re-imaging the Windows machine. The Agent must then be given
  the new secret (re-run its registration/configuration step with the new
  value — the exact mechanism is `apps/agent`'s to document) before it can
  authenticate again.
- **Revoke** (disable): sets the Agent's status so no further authenticated
  call succeeds, without issuing a replacement. Use this when decommissioning a
  machine or if an Agent should stop operating entirely (e.g. it's printing to
  a queue that no longer exists).

Both actions are audit-logged (architecture.md sec 4, `audit_logs` table).

## 6. Uninstalling

1. From the dashboard, **revoke** the Agent's credential first (§5), so a
   stray running copy can't keep claiming jobs after you've decided to remove
   it.
2. Stop and remove the Windows service (if installed as one) — the reverse of
   whatever `node-windows`-based install step `apps/agent/README.md` documents.
3. Remove the Agent's local data directory (device secret, any queued/
   in-flight job files, logs) if you want a clean removal rather than leaving
   stale local state behind.
4. If the physical printer/queues are also being decommissioned, remember the
   corresponding `printer_profiles` rows in the dashboard still reference this
   Agent's `agent_id` (`printer_profiles.agent_id`, foreign key with
   `on delete restrict` — see `supabase/migrations/0002_printing_tables.sql`) —
   you cannot delete the `agents` row itself while profiles still reference it;
   reassign or remove those profiles first if the printer is truly going away,
   or simply leave the revoked Agent row in place as a historical record if the
   printer/queues persist under a different Agent.
