# Agent ↔ Cloud API contract

This is the canonical contract between `apps/web`'s agent-facing Route Handlers and
`apps/agent`. Both sides implement exactly this; if either side needs to change it, update
this file first. See `docs/architecture.md` sec 4 (agent auth), sec 13 (leasing), sec 12
(remote commands).

Polling, not a persistent connection: the Agent polls `heartbeat` and `jobs/claimable` on a
short interval (default 15s, configurable). This is deliberately simpler and more robust
than a WebSocket for V1 - it survives reconnects trivially and needs no server-side
connection state. Supabase Realtime may be layered in later purely as a latency
optimization (the Agent could also subscribe to a realtime "job approved" ping to poll
immediately instead of waiting for the next interval) - not required for correctness.

## Authentication

Every request except `register` carries:

```
Authorization: Bearer <agentId>.<deviceSecret>
```

The server looks up `agents` by `agentId`, verifies `deviceSecret` against
`device_secret_hash` (scrypt/bcrypt), confirms `status = 'active'`, and scopes every
subsequent query to that agent's `organization_id`. Invalid/revoked credentials -> 401.
This is a bearer credential the Agent owns, never a Supabase Auth JWT and never the
service-role key (see `docs/architecture.md` sec 4).

## Endpoints

### `POST /api/agents/register`
One-time. Body: `{ "enrollmentCode": string }`.
Looks up `agents` by `enrollment_code` (must be unexpired), generates a new random device
secret, stores only its hash, clears the enrollment code, sets `status = 'active'`.
Response: `{ "agentId": string, "deviceSecret": string, "organizationId": string }` - the
plaintext secret is returned exactly once and never retrievable again; rotation issues a
new one and invalidates the old.
Rate limited per source IP (10 attempts / 5 minutes, `docs/architecture.md` sec 18) - a
`429` means back off and retry later, it does not consume the enrollment code.

### `POST /api/agents/heartbeat`
Body:
```json
{
  "version": "1.0.0",
  "queues": [
    { "windowsQueueName": "Kyocera_Main", "driverName": "KX DRIVER", "portName": "IP_10.0.0.5", "status": "ready" }
  ]
}
```
Updates `agents.last_seen_at`, `agents.version`. `queues` is informational (printer
discovery reporting, sec 11/38) - it does not auto-create profiles. Two things happen with
it: (1) any queue that matches an existing `printer_profiles.windows_queue_name` for this
agent updates that printer's `status`/`last_status_at`; (2) the full raw array (plus a
server-set `reportedAt` per entry) is written to `agents.discovered_queues`, overwritten in
full each heartbeat that includes queues (never accumulated - it reflects only the most
recent report). The guided setup wizard (`app/admin/printers/setup`) reads
`discovered_queues` to populate a real dropdown of this agent's Windows queue names instead
of an admin hand-typing one. A heartbeat with no `queues` (or an empty array) leaves both
untouched - silence isn't the same as "this agent now sees zero queues."

An optional `machine` block reports what the Agent knows about the PC it runs on
(`apps/agent/src/machine-info.ts`):

```json
{
  "machine": {
    "hostname": "FRONT-OFFICE-PC",
    "osVersion": "Windows_NT 10.0.19045 (x64)",
    "ipAddresses": ["10.0.0.42"],
    "isGitCheckout": true
  }
}
```

It writes `agents.hostname` / `os_version` / `ip_addresses` / `is_git_checkout`, which the
per-Agent admin page (`app/admin/agents/[agentId]`) displays so an admin can tell which
physical machine a row is. Every field is optional, trimmed, and length-capped server-side;
a field the Agent omits leaves its column untouched rather than nulling it, so an older
Agent build simply reports nothing and nothing is lost. **These values are display-only** -
they are never used to authenticate, authorize, or route anything (`docs/architecture.md`
sec 3.2), which is what makes accepting a self-report safe here at all.

Response: `{ "ok": true, "serverTime": "<ISO>", "paused": boolean }`. `paused` mirrors
`agents.paused`; the Agent honors it by not polling for claimable jobs while set. That is
**defense in depth only** - the pause is enforced by the two job-handing routes below, so
an Agent that ignores this field still gets no work.

### `GET /api/agents/jobs/claimable`
Returns jobs in `approved` status whose `printer_profiles.agent_id` is this agent, that are
unclaimed or whose lease has expired.
Response: `{ "jobs": [{ "jobId": "...", "printerProfileId": "...", "jobNumber": "JOB-2026-000184" }] }`.
**Oldest first** (`ORDER BY created_at, id`), at most **50** jobs; the Agent works through the list in that order, one job at a
time, so a school of teachers sending at once is served in the order they sent. A job that is *waiting for the printer* (see
`release` below) has `lease_expires_at` in the future and is therefore not listed until its next attempt is due.
While `agents.paused` is set, this returns `{ "jobs": [] }` unconditionally - being paused
is a normal administrative state, not a fault, so it is an empty list rather than an error
the Agent would back off from.

### `POST /api/agents/jobs/:jobId/claim`
Atomic claim (see `docs/architecture.md` sec 13): only succeeds if the job is still
`approved` and unleased/lease-expired, and its `printer_profiles.agent_id` is this agent.
On success: transitions `approved -> claimed`, sets `lease_owner_agent_id`,
`lease_expires_at = now() + organization_settings.job_lease_minutes`, records
`AGENT_CLAIMED`. Response `200 { "ok": true, "leaseExpiresAt": "<ISO>" }`, or
`409 { "ok": false, "reason": "already_claimed" }`.
A paused agent (`agents.paused`) is refused here too, before any lookup, with
`409 { "ok": false, "reason": "agent_paused" }` - deliberately the same conflict shape an
existing Agent build already handles as "someone else got it, move on". This is the
enforcement point that matters: an Agent holding a job id it learned before the pause, or
one ignoring the heartbeat's `paused` flag entirely, still cannot take the job.

### `GET /api/agents/jobs/:jobId/download-url`
Requires an active lease held by this agent. Resolves the logical print request (never a
raw queue name to an untrusted client elsewhere in the system, but the Agent *is* the
trusted party this resolves for):
```json
{
  "downloadUrl": "https://.../storage/v1/object/sign/...",
  "expiresInSeconds": 300,
  "fileName": "Homework.pdf",
  "printRequest": {
    "jobId": "...",
    "printerProfileId": "...",
    "windowsQueueName": "Kyocera_Main_Booklet",
    "pageCount": 8,
    "copies": 1,
    "colorMode": "bw",
    "duplex": true,
    "paperSize": "letter",
    "finishing": { "staple": false, "booklet": true, "punch": false },
    "fitMode": "noscale"
  }
}
```
`pageCount` reflects whatever file `derivedFilePath`/`downloadUrl` actually points to: for a
booklet job this is the *imposed* page count (N/2 landscape sheet-sides), not the padded
source page count (N) - see `docs/architecture.md` sec 8. `fitMode` is present ONLY for a
booklet job (always `"noscale"`, since Printio has already imposed and independently scaled
every page - asking the driver to `fit`/`shrink` further would undo that); it is absent for
every other job, and the Agent falls back to its own `PRINTIO_PRINT_FIT_MODE` default.
Without a query parameter it also transitions `claimed -> downloading` and records `DOWNLOAD_STARTED` (older Agents).
With **`?keepClaimed=1`** (current Agents) the job stays `claimed` - the only state it can be released back to the queue from -
and the response says so: `"jobStatus": "claimed"` (an older server ignores the parameter and answers `"downloading"`, or omits the
field; the Agent then falls back to the old behaviour). The Agent reports `downloading`, `downloaded`, `printing`,
`submitted_to_spooler`, `completed` itself after the document has really been sent (raw path), see `status`.

### `POST /api/agents/jobs/:jobId/status`
Body: `{ "status": JobState, "message"?: string, "metadata"?: object }`. Requires the lease.
Validates the transition against the same allowed-transition table as the DB trigger
(defense in depth - the DB trigger is the final backstop either way), updates
`print_jobs.status`, appends a `print_job_events` row with `actor_type: "agent"`. Expected
sequence from the Agent: `downloaded` (after saving the file locally) -> `printing` (before
invoking SumatraPDF) -> `submitted_to_spooler` (exit code 0) -> `completed` (spooler job left
the queue cleanly) or `failed` (any error, with `message`/`metadata` populated - see
`docs/known-limitations.md` for what `completed` does and doesn't guarantee).
`downloading` is also reportable (`claimed -> downloading`, event `DOWNLOAD_STARTED`) for Agents that used `keepClaimed`.
Response: `{ "ok": true }`.

### `POST /api/agents/jobs/:jobId/release`
Body `{ "kind": "unavailable" | "unknown", "detail"?: string }`. Requires the lease, and the job must still be **`claimed`**
(`409 wrong_state` otherwise: once downloading/printing some bytes may be at the printer and the DB transition rule does not allow
going back). Called when the Agent could not hand the document to the printer: raw connect timed out / refused / unreachable, a
write stalled (`unavailable`), another socket error or an unclassified failure, or the document could not be fetched because the
network/storage was down (`unknown`). **That is not a failed print**: the raw port buffers data and prints when the printer is ready.

The job goes back to `approved` (`claimed -> approved`, an existing legal transition), `lease_owner_agent_id = null`, and
`lease_expires_at = now + backoff` - the claimable/claim filter (`lease_expires_at is null or < now`) hides it until then.
Backoff by number of releases: **30 s, 1 min, 2 min, then 5 min** (capped). `attempt_count` is **not** touched and the quota
reservation is **not** released. The reason lives in `print_jobs.error_message` behind a stable marker (no migration):

    [printio:waiting v1 since=<ISO time> tries=<n> kind=<unavailable|unknown>] <plain sentence>

`since` is the first time the job could not be sent (kept across retries and Agent restarts), the sentence is "The printer is not
available right now (off, offline or network). It will print when it is back." or "Waiting for the printer - status unknown".
Display code treats a job as *waiting* only when `status` is `approved` (or briefly `claimed` while being retried) AND the marker
is present (`apps/web/lib/job-waiting.ts`); it is a queued job, never counted as failed. One `RETRY_SCHEDULED` event (metadata
`{ waiting: true, kind, retryAt }`) is recorded when the job first starts waiting.

When `since + window` has passed (default **2 hours**, `PRINTIO_WAITING_WINDOW_MINUTES` on the web app, 1 min - 7 days) the same call
fails the job instead: `claimed -> failed` with `error_message = "[printio:gave-up] The printer was not available for 2 hours ..."`,
`attempt_count` unchanged and the reservation kept, so the owner's **Try again** works; it is never auto-requeued.
Response: `200 { "ok": true, "outcome": "waiting", "tries": n, "retryAt": "<ISO>" }` or `200 { "ok": true, "outcome": "failed" }`.
`404` = an older web app without this endpoint: the Agent then reports `failed` exactly as before. Truly permanent problems (the
job cannot be built, the document is missing or not a PDF) are still reported with `status: failed` at once.

### `GET /api/agents/commands`
Returns this agent's `pending` `remote_commands` rows: `{ "commands": [{ "id", "command",
"payload" }] }`. `command` is always one of the fixed allow-listed values (sec 12) - the
Agent's handler is a `switch` over this exact set, never a raw string executor.

### `POST /api/agents/commands/:commandId/ack`
Body: `{ "status": "completed" | "failed", "result"?: object }`. Updates `remote_commands`
and mirrors into `audit_logs`.

## Error format

Every error response: `{ "error": { "code": string, "message": string } }` with an
appropriate HTTP status (400 validation, 401 auth, 403 org/lease mismatch, 404 not found,
409 conflict, 500 unexpected - never a raw stack trace or DB error to the client).
