# PrintOS Architecture

This document is the source of truth for how PrintOS is built and why. It exists because
this system prints real documents on real machines for real students and staff, and every
design choice here was checked against current official documentation before being
implemented (see "Research basis" at the end of each section). Where something cannot be
done reliably, that limitation is stated plainly rather than hidden behind a fake success
state — see [Known Limitations](./known-limitations.md).

## 1. System overview

```
┌─────────────────────┐        ┌──────────────────────────┐        ┌────────────────────┐
│  Browser (student/   │        │      PrintOS Cloud       │        │  Windows Print      │
│  staff/admin)        │◄──────►│  Next.js (Vercel)        │◄──────►│  Agent (on-prem)    │
│  Chromebook/desktop  │  HTTPS │  Supabase (Auth/DB/      │  HTTPS │  Node.js/TypeScript  │
└──────────────────────┘        │  Storage/Realtime)       │  out-  └──────────┬───────────┘
                                 └──────────────────────────┘  bound            │
                                                                                  ▼
                                                                     ┌────────────────────┐
                                                                     │ Windows Print Spooler│
                                                                     │ + named printer      │
                                                                     │ queues (KX driver)   │
                                                                     └──────────┬───────────┘
                                                                                ▼
                                                                     Kyocera TASKalfa MFP
```

Two independent deployables share one Postgres database (via Supabase) and one type
package:

- `apps/web` — the cloud app. Next.js 16, App Router, Server Actions + Route Handlers,
  deployed to Vercel. Talks to Postgres via Supabase (server-side, RLS-enforced) and to
  Supabase Storage/Realtime.
- `apps/agent` — the on-premises Windows Print Agent. Node.js + TypeScript, packaged as a
  Windows service. Never receives the Supabase service-role key; authenticates as itself
  (see §4).
- `packages/shared` — types, the policy/rules engine, job state machine, and page/sheet/
  cost math, imported by both.

The **cloud never talks to the printer**. It talks to Postgres/Storage. The Agent is the
only thing that talks to Windows, and Windows (via the installed KX driver) is the only
thing that talks to the Kyocera device. This is non-negotiable — see §7.

## 2. Multi-tenancy & authentication

### 2.1 Organization membership model

`organization_id` is never a column directly on the user/profile row. Membership is a
join table (`organization_members`), which is also what current Supabase RLS guidance
uses for exactly this shape (a security-definer helper returning the caller's org IDs,
used with `IN` rather than a join inside the policy — see §3). This leaves room for a
user to belong to more than one organization later without a schema migration.

`profiles` mirrors `auth.users` 1:1 (id = auth.users.id) rather than duplicating identity
data. `profiles.platform_role` (`user` | `super_admin`) is a **platform-level** flag,
separate from any organization role — a super_admin can create organizations but has no
implicit access to any organization's print jobs (RLS does not grant them one; a
super_admin's org-scoped support access must go through explicitly becoming a member, and
that action itself is audit-logged).

### 2.2 No auto-admin-by-domain

The spec forbids "first person from an allowed domain becomes admin," and this is not
just a policy choice, it follows from Supabase's own trust-boundary rules for `auth.users`
metadata: end-user-writable `user_metadata` must never gate authorization, and there is no
Supabase-side concept of organizations at all, so nothing about the OAuth login itself can
imply org admin.

Bootstrap paths, both requiring an explicit, auditable row before any org-scoped access is
granted:

1. **Super-admin creates org + first admin.** A platform super_admin creates the
   `organizations` row and an `organization_members` row (role=`org_admin`) for a named
   person, in one server-side transaction. That person then signs in with Google OAuth;
   their `auth.users` row and the pre-created membership row link by email (verified) or by
   accepting an invitation token sent to that email.
2. **Organization enrollment code / invitation.** An existing `org_admin` creates a row in
   `organization_invitations` — either targeted at a specific email or an open enrollment
   code — with `max_uses`, `expires_at`, and a `role` **capped below `org_admin`** unless
   the creator is themselves an `org_admin` explicitly promoting someone. Redeeming an
   invitation is a service-role server action that validates the token/expiry/use-count and
   inserts the `organization_members` row; it is never derived from email-domain matching.

`organizations.allowed_domains` exists only as a UX hint (e.g. "suggest this org to people
signing in from @school.org") — it is read to prefill an invitation-request screen, never
to grant membership or role.

### 2.3 Session claims

A Supabase **Custom Access Token Hook** stamps the caller's active organization id + role
into the JWT (`app_metadata`-backed custom claims) after a membership row exists, so RLS
policies and Realtime channel authorization (§3.4) can check `auth.jwt()` cheaply. Because
JWT claims can go stale after a role change until the token refreshes, session lifetime is
kept short, and any *sensitive* server action (role change, policy edit, remote command)
re-checks `organization_members` live rather than trusting the cached claim alone.

**Research basis:** Supabase's own RBAC guide's `app_metadata` vs `user_metadata` trust
rule; the "Before User Created"/"Custom Access Token" hooks docs; the fact that Supabase
explicitly ships no organization/invitation primitive and expects this to be built on top
(`supabase/docs` auth-hooks guides; GitHub discussion supabase#6055).

## 3. Row Level Security & data access

RLS is enabled on **every** multi-tenant table. No table is queried by the browser through
a policy-free path; `apps/web` server code uses the anon/authenticated Supabase client for
all user-driven reads/writes so RLS is always the enforcement point, and reserves the
service-role client for a short, explicit list of privileged operations that must bypass
RLS by design (invitation redemption, agent registration, cross-tenant super-admin
provisioning) — each such usage is isolated in `apps/web/lib/server/service-role.ts` and
never imported into a client component.

### 3.1 Membership helper function

```sql
create or replace function private.user_org_ids()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select organization_id from public.organization_members
  where user_id = auth.uid() and status = 'active'
$$;
```

Policies use `organization_id in (select private.user_org_ids())` — never a join between
the source table and `organization_members` inside the policy body — per Supabase's own
documented RLS performance guidance (a join-based policy benchmarks up to ~99.99% slower
than the `IN (subquery)` form at scale). `auth.uid()` calls are wrapped in `(select ...)`
so Postgres caches the value per statement instead of re-evaluating per row, and every
policy specifies `to authenticated` so anonymous traffic short-circuits before the policy
body runs.

### 3.2 Never trust client-supplied identity

`organization_id`, `role`, `user_id`, `printer_id`, `page_count`, and approval status are
never taken from the request body/browser state for anything that affects authorization,
quota, or policy. Server Actions/Route Handlers always re-derive them from the
authenticated session and the database (e.g. page count comes from parsing the uploaded
PDF server-side — see §5 — never from a client-reported number).

### 3.3 Storage

Uploaded files live in a **private** bucket (`print-jobs`), path-scoped as
`org/{organizationId}/jobs/{jobId}/original.pdf` and `.../derived.pdf`. Storage RLS
policies parse the path with `storage.foldername()` and check the org segment against
`private.user_org_ids()`, mirroring the table policies. Downloads (by the browser, for a
preview, or by the Agent, for printing) go through **short-lived signed URLs**
(`createSignedUrl`, expiry in minutes) — never a public URL.

One documented nuance this design accounts for: Storage signed URLs are minted with a key
separate from the Auth JWT signing key, so rotating the Auth JWT secret does **not**
invalidate already-issued signed URLs; there is no self-service early revoke. Expiries are
therefore kept short (default 5 minutes for Agent job downloads, 2 minutes for browser
preview) rather than relied upon to be revocable.

### 3.4 Realtime

Realtime "public channels" are **disabled** at the project level. All channels are
`private: true` and authorized by RLS policies on `realtime.messages`, scoped by topic —
topic convention `org-{organizationId}:{stream}` (e.g. `org-<id>:jobs`,
`org-<id>:approvals`, `org-<id>:agents`). A policy checks that the caller is an active
member of the organization named in the topic before granting `select`/`insert` on that
topic's messages, so org A's browser session cannot subscribe to org B's stream even if it
guesses the topic string. `postgres_changes` subscriptions (used for a couple of simple
list-refresh cases) inherit the underlying table's RLS as a second layer of defense.

**Research basis:** Supabase RLS guide (join-elimination, `(select auth.uid())`, indexing,
`to authenticated`); Supabase Storage docs (`buckets/fundamentals`,
`storage/security/access-control`, `storage/schema/helper-functions`,
`storage/serving/downloads` — signed URL key separation); Supabase Realtime Authorization
guide and the Broadcast/Presence Authorization announcement.

**V1 implementation note:** the private broadcast-channel policies above (migration
`0008_realtime.sql`) are in place, but this build's actual client subscriptions use
`postgres_changes` directly on `print_jobs`/`agents`/`remote_commands` (added to the
`supabase_realtime` publication in `0011_realtime_publication.sql`) rather than
server-side `broadcast()` calls. For a single-organization prototype this is simpler —
zero custom broadcast-sending code — and exactly as secure, since `postgres_changes`
visibility is still fully governed by each table's own RLS policies (§3.1-3.2), so org A's
client still cannot receive org B's row changes. The broadcast-channel pattern remains
available as a drop-in upgrade if/when fan-out volume across many orgs justifies it.

## 4. Agent identity & authentication

Each Agent is registered explicitly by an org_admin and receives its own credential — the
Agent **never** ships or holds `SUPABASE_SERVICE_ROLE_KEY`. Registration:

1. Admin creates an `agents` row (status=`pending`) in the dashboard and is shown a
   one-time enrollment code.
2. The Agent, on first run, exchanges that code (over HTTPS, outbound only) for a
   long-lived device secret via `POST /api/agents/register`. The server stores only a
   salted hash of the secret (`device_secret_hash`), never the plaintext.
3. Every subsequent Agent call presents the secret (as a bearer credential); the server
   looks up the Agent by id, verifies the hash, and scopes every query to that Agent's
   `organization_id` — an Agent can never read or act on another organization's jobs,
   printers, or files, enforced the same way as browser RLS (the Agent's Route Handlers run
   the query as that Agent's identity context, not as service-role).
4. Admins can rotate (issue a new secret, old one stops working immediately) or revoke
   (disable) an Agent from the dashboard; both are audit-logged.

Heartbeats (`POST /api/agents/heartbeat`) update `agents.last_seen_at` and report agent
version + configured printer queues; the dashboard derives online/offline from staleness
of `last_seen_at` (no persistent connection is required or held open — see §8).

## 5. PDF preflight

Every upload is validated server-side before anything else happens:

- MIME type and actual PDF structure are checked (not just the filename/extension).
- Page count is computed by parsing the PDF server-side — the browser-supplied count (if
  any, e.g. from a client-side preview) is never trusted or stored as authoritative.
- File size is checked against a configurable per-organization maximum before the file is
  fully persisted.
- A malformed PDF is rejected with a clear error and a `PREFLIGHT_REJECTED` job event; it
  never reaches the policy engine or storage as a "real" job.

Optional/V1.5: thumbnail generation, mixed-page-size detection, landscape/portrait
detection. These are explicitly optional and never gate the core upload → print flow.

## 6. Print policy / rules engine

### 6.1 Why not a boolean

A single `require_approval` boolean cannot express "staff auto-approved under a threshold,
but color or >20 pages needs approval" without also hard-coding that specific threshold
into application logic, which is exactly what the spec forbids. Instead, policies are data:
an organization has one or more `print_policies`, each holding an ordered set of
`policy_rules`.

### 6.2 Rule shape

Each rule has:
- `action`: `allow` | `require_approval` | `deny`
- `conditions`: a list of conditions, **implicitly AND-ed** (all must match for the rule to
  fire) — e.g. `[{field: "role", op: "eq", value: "staff"}, {field: "page_count", op: "lte",
  value: 20}, {field: "color_mode", op: "eq", value: "bw"}, ...]` for a staff auto-allow
  envelope.
- `reason_label`: the human-readable string recorded/shown when this rule contributes to
  the decision (e.g. "Exceeds 20-page staff threshold").
- `priority`: an integer used only to order reasons deterministically when several rules in
  the same tier match; it does not change which tier wins (see §6.3).

**OR logic across different criteria is expressed as multiple rules in the same tier**,
not as boolean expressions inside one rule. This is why the spec's example — "Color OR
>20 pages OR >5 copies OR 11x17 OR booklet OR stapling → require approval" — is modeled as
six separate `require_approval` rules, each with its own single-purpose `reason_label`.
That directly produces the spec's example admin-facing output:

```
Approval Required
Reason:
• Student account
• 37 pages exceeds 20-page staff threshold
• Color printing requires approval
```
— three different rules matched, and all three reasons are shown, not just the first.

### 6.3 Precedence model (deterministic, documented)

```
1. Any matching DENY rule            → action = DENY
2. Else any matching REQUIRE_APPROVAL → action = REQUIRE_APPROVAL
3. Else any matching ALLOW rule        → action = ALLOW
4. Else organization default action    → organization_settings.default_policy_action
```

Within the winning tier, **every matching rule's `reason_label` is collected** (ordered by
`priority`, deduplicated) and stored on the job (`print_jobs.policy_reasons`) alongside the
resolved `policy_action`. This is what lets an administrator see *why* a job landed where
it did, and it is stored, not just displayed transiently, satisfying the audit requirement.
`organization_settings.default_policy_action` defaults to `require_approval` (fail safe,
not fail open) — an organization with no rules configured requires approval on everything
rather than silently allowing everything.

Evaluation is pure and synchronous: given a fact object (see `packages/shared/src/
policy-engine.ts`) and the org's enabled rules, `evaluatePolicy()` returns
`{ action, reasons[] }` with no I/O — the caller (a Server Action) is responsible for
first computing the facts (verified page count, quota-usage percentage, etc.) from the
database and the preflight result, so the engine itself stays trivially unit-testable and
never trusts client input.

### 6.4 Quota facts feed the same engine

Quota usage (`monthly_quota_usage_pct`) is just another fact available to a rule condition
(e.g. "REQUIRE_APPROVAL when monthly_quota_usage_pct >= 90"), rather than a separate code
path — one engine, one precedence model, one place reasons are generated.

## 7. Print math: pages, sides, sheets, cost

These are deliberately kept distinct (§6 of the spec):

- `sourcePdfPages` — server-verified page count of the uploaded (or booklet-derived) PDF.
- `printedSides = sourcePdfPages × copies` — one PDF page = one printed side, regardless of
  duplex (duplex changes how sides map onto sheets, not how many sides exist).
- `physicalSheets`:
  - Non-booklet: `ceil(sourcePdfPages / (duplex ? 2 : 1)) × copies`.
  - Booklet: imposition places 4 pages per physical sheet (2 per side, always duplex) —
    `ceil(paddedPages / 4) × copies`. `paddedPages` accounts for booklet padding (§8).
- `colorMode` is the **requested** mode (`bw`/`color`), and the requested mode alone is
  sufficient and safe to gate an approval rule on ("color requested → approval") without
  needing real content analysis. Actual PDF color-content detection (checking whether a
  page is *really* not just DeviceGray) is out of scope for V1 and, if added later, must be
  labeled as an analysis result with documented false-negative/positive risk, never treated
  as ground truth for billing or policy.
- `estimatedCostCents` is computed only when an organization has configured pricing
  (`printer_profiles`/org-level rate table); cost tracking is optional and orgs may track
  pages/sheets with no financial dimension at all.

`organization_settings.quota_basis` picks which of the four numbers
(`pdf_pages`/`printed_sides`/`physical_sheets`/`color_weighted`) quota enforcement is
measured in; **the documented default is `physical_sheets`**, because it is the number
that corresponds most directly to a physical resource (paper) consumed, and is unambiguous
regardless of duplex/copies configuration.

## 8. Booklet padding & imposition

Booklet imposition requires a page count that is a multiple of 4. If not, the user is
shown the exact padding math (spec's UX: "This document contains 6 pages... Add 2 blank
pages?") and, on confirmation, a padded copy is generated with blank pages appended
(`apps/web/lib/pdf/booklet.ts`'s `createBookletPaddedPdf`). The **original upload is never
modified or overwritten** — `print_jobs.original_file_path` and `derived_file_path` are
stored separately, and `print_job_events` records the exact padding transformation
(`{"type": "booklet_padding", "pages_added": 2}`), so an audit can always see both what the
user uploaded and what was actually sent to the printer.

Padding alone is not booklet printing. PrintOS performs its own real N-up saddle-stitch
**imposition** (`apps/web/lib/pdf/imposition.ts`) on the padded PDF before it is ever
uploaded as `derived_file_path` — the file the Agent downloads and sends to the printer is
already the final, laid-out sheet, not a plain page-sequential PDF left for the driver to
re-flow into a booklet.

**Why not just use the driver's own booklet mode, and what "real imposition" buys over
it:** a Windows print driver's booklet feature picks **one uniform scale factor for the
entire document**, sized so the single worst-case page (e.g. one oversized image or wide
table) fits without clipping — every other, normally-sized page is then forced down to that
same worst-case scale and surrounded by needlessly large margins it never needed. PrintOS's
imposition instead computes each source page's scale **independently** (the same principle
Adobe Acrobat's booklet printing uses): each page is scaled up to the largest size that fits
its own half-sheet slot, preserving its own aspect ratio, capped at 1.0 (a page is centered,
never upscaled past its native size — enlarging embedded raster content past its native
resolution buys nothing but softness). A normal page prints large; only the one problem page
shrinks further. That per-page independence — not the padding — is the actual point of this
feature.

Mechanically, for a padded document of `N` pages (S = N/4 sheets), `bookletPageOrder`
produces the standard saddle-stitch signature order: sheet `s` (0-indexed) has front
left/right = `[N-2s, 2s+1]` and back left/right = `[2s+2, N-2s-1]`, sheet 0 outermost. Each
output PDF page is the target sheet (read from the job/printer profile's own `paperSize`,
never hardcoded — see `resolvePaperSizePoints`) in **landscape** orientation, holding two
source half-pages side by side with a small fixed margin and center gutter. Output page `k`
(0-indexed) is physical sheet `Math.floor(k/2)`, front if `k` is even, back if odd —
consistent with how duplex printing already works elsewhere in this system (consecutive PDF
pages alternate front/back of one physical sheet via the driver's own duplex unit), not a
new duplex model.

Because PrintOS now does its own precise per-page scaling, a booklet job must NOT also ask
the driver to `fit`/`shrink` — that would silently re-scale an already-correctly-sized page
and undo the whole point of imposing it. `ResolvedPrintRequest.fitMode` is set to
`"noscale"` for a booklet job only (`apps/web/app/api/agents/jobs/[jobId]/download-url/route.ts`);
every other job leaves it unset and the Agent falls back to its own machine-level
`PRINTOS_PRINT_FIT_MODE` default, exactly as before this field existed
(`apps/agent/src/orchestrator.ts`). This is a value chosen upstream in the cloud and passed
down through the existing `fitMode` field — it does not change what the Agent's
`print-executor.ts` is allowed to do with it, and that module still never reads `finishing`
off the resolved print request (sec 9-10).

The physical sheet count is unaffected by imposition — `computePrintMath` (sec 7) still
counts `Math.ceil(paddedPageCount / 4)` sheets regardless of whether those 4 padded pages
end up laid out across 2 imposed landscape sides; only what is drawn on each sheet changes,
not how many sheets there are, so quota consumption (sec 14) is unaffected.

## 9. Printer profiles & the driver/finishing architecture

This is the architectural decision the spec most insists on getting right, and the
research (Kyocera KX driver docs, Windows DEVMODE/DocumentProperties docs, SumatraPDF
docs) unanimously confirms the same answer:

**Finishing options (staple, punch, booklet/saddle-stitch, and most driver-specific
behavior) live in the printer driver's private DEVMODE extension data, are not exposed by
any cross-vendor Windows API or by SumatraPDF's command line, and Kyocera itself documents
exactly one supported mechanism for reusable finishing setups: the KX driver's own
"Profiles/Favorites" GUI feature or an admin-set per-queue "Printing Defaults" — both
GUI-only, with no CLI/API selection hook.** (Kyocera's PRESCRIBE page-description language
does have raw `FOLD`/`BKLT` commands, but using them means hand-generating a raw print
stream outside the normal driver pipeline — not a supported scripting layer on top of
ordinary document printing. Not used here.)

Consequently, PrintOS does not attempt to program finishing options at print time at all.
Instead:

- An administrator configures each physical printer as one or more **`printer_profiles`**
  rows, each pointing at a distinct, **pre-configured Windows printer queue**
  (`windows_queue_name`) whose driver "Printing Defaults" already bake in that profile's
  finishing options (e.g. `Kyocera_Main` = plain duplex default, `Kyocera_Main_Booklet` =
  booklet+saddle-stitch default, `Kyocera_Main_Stapled` = corner-staple default). Setting
  those defaults is a one-time, on-site, driver-GUI task per queue (documented in
  [printer-setup.md](./printer-setup.md)), not something PrintOS's software does remotely.
- The cloud never sends a raw Windows queue name to an untrusted client. A print job
  carries a **logical** `printerProfileId`; the Agent resolves it to the actual Windows
  queue name from its own configuration (fetched over its authenticated channel), matching
  the spec's example JSON shape.
- What PrintOS's Agent *does* control per job, via SumatraPDF's currently-documented
  `-print-settings` tokens, is the generic subset that is genuinely cross-driver-safe:
  page range, `color`/`monochrome`, `duplex`/`duplexshort`/`duplexlong`/`simplex`,
  `fit`/`shrink`/`noscale`, `collate`, `bin=`/`paper=` (matched against the driver's own
  reported names), and copy count via the `Nx` token. Anything beyond that (staple,
  punch, booklet imposition itself) is the queue's job, not a command-line flag's job.
- **Printer capabilities in the database (`printer_profiles.declared_capabilities`) are
  administrator-declared, not verified by the cloud.** The UI never claims "this printer
  can staple" as fact from the database alone; the source of truth is what the admin
  configured on that Windows queue. The Agent's printer-discovery feature (§11) reports
  what Windows can see about a queue (driver name, port, status) so an admin can cross-check
  their declared profile against reality, but PrintOS cannot introspect a driver's private
  DEVMODE finishing state from software, so it does not pretend to.

## 10. SumatraPDF invocation

The Agent invokes SumatraPDF with an **argv array**, never a shell string — printer queue
names, file paths, and profile-derived settings are all validated configuration or
Agent-controlled values, never interpolated from unsanitized input:

```ts
spawn(sumatraPdfExe, [
  "-print-to", resolvedWindowsQueueName,
  "-print-settings", settingsString, // built from a small allow-listed token vocabulary
  "-silent",
  localPdfPath,
]);
```

The Agent records the process exit code, stdout/stderr, and duration for every invocation.
A successful (exit 0) SumatraPDF process only means **the spooler accepted the job** — see
§13 and [known-limitations.md](./known-limitations.md) for why that is not the same as
physical completion, and how `submitted_to_spooler` vs `completed` are tracked as distinct,
separately-timestamped job states rather than being collapsed into one "printed" moment.

## 11. Windows spooler monitoring

The Agent uses the PowerShell **PrintManagement** module for enumeration and control:
`Get-Printer`/`Get-PrinterPort`/`Get-PrinterDriver` for discovery, `Get-PrintJob
-PrinterName <queue> -ID <id>` to poll its own submitted job, and `Remove-PrintJob
-PrinterName <queue> -ID <id>` to cancel it. Both the read and the remove cmdlets take
`-PrinterName` as a mandatory parameter with no ID-only or cross-printer form, so a
correctly written Agent (which always records the exact queue name + job id pair it
submitted) structurally cannot address another printer's queue — it is scoped by
construction, not by convention alone. The Agent never enumerates "all jobs on all
printers and filters by ID"; it always calls with both the queue name and the ID.

Broad recovery actions (deleting the entire spool directory, restarting the spooler
service) are last-resort, **whole-machine** operations — restarting the spooler affects
every queue on that machine — and are only ever invoked as the explicit
`RESTART_PRINT_QUEUE`/`RESTART_AGENT_SERVICE` allow-listed commands (§12), never as a
routine per-job recovery step, and always followed by a fresh status check rather than an
assumption of success.

## 12. No arbitrary remote command execution

The cloud can send an Agent exactly one of a fixed, allow-listed set of commands, each with
a fixed implementation on the Agent side — never a raw shell/PowerShell string:

```
REFRESH_PRINTER_STATUS
CANCEL_PRINT_JOB        (payload: { job_id })
RESTART_PRINT_QUEUE     (payload: { printer_profile_id })
RESTART_AGENT_SERVICE
CLEAR_AGENT_TEMP_FILES  (only files under the Agent's own PrintOS temp directory)
```

Every issuance is authenticated (admin session), authorized (admin must be an org_admin of
the target Agent's organization), recorded in `remote_commands` with the issuing admin id,
and mirrored into `audit_logs`. The Agent's command handler is a `switch` over this fixed
set — there is no code path that accepts or `eval`s an arbitrary string from the cloud.

## 13. Job state machine & leasing

See `packages/shared/src/job-state.ts` for the canonical enum and allowed-transition table
(kept in sync with the `print_jobs.status` CHECK constraint). Summary:

```
draft → pending_approval → approved → claimed → downloading → downloaded
      → printing → submitted_to_spooler → completed

pending_approval → rejected | expired | cancelled
draft → approved (auto-allow) | denied (auto-deny)
approved → expired (not claimed in time) | cancelled
claimed → approved (lease expired, released back to the pool) | failed | cancelled
failed → claimed (retry, if attempt_count < max_attempts) | cancelled (retries exhausted)
```

Jobs never jump `approved → completed`; every intermediate transition is written as both a
`print_jobs.status` update and an immutable `print_job_events` row (actor, timestamp,
metadata), which is what makes a stuck real-world job diagnosable after the fact.

**Leasing.** Only one Agent may hold a job at a time: claiming a job is an atomic
`UPDATE ... WHERE status = 'approved' AND (lease_owner_agent_id IS NULL OR
lease_expires_at < now()) RETURNING *` — the same optimistic-lock shape used for the quota
reservation in §14 — so a duplicate claim attempt (Agent restart, reconnect, cloud retry)
simply affects zero rows instead of double-claiming. A lease has a TTL
(`lease_expires_at`); if an Agent disappears mid-job, the lease expires and the job returns
to `approved` for another Agent (or the same one, after it reconnects) to claim — the cloud
never simply "waits forever" for a vanished Agent.

## 14. Quota enforcement (race-safe)

Quota consumption is **reserved at submission time**, inside the same database transaction
that evaluates policy and creates the job, using `monthly_usage.reserved_physical_sheets`
(or whichever basis is configured) incremented under a row lock
(`SELECT ... FOR UPDATE` on the user's `monthly_usage` row for the current period, upserting
it first if absent). Two concurrent submissions from two browser tabs therefore cannot both
read a stale "under quota" snapshot and both proceed — the second transaction blocks on the
row lock and re-evaluates against the already-incremented reservation. A reservation is
released (not double-counted) if the job is later denied/rejected/cancelled/expired/failed
without ever printing, and is converted from "reserved" to actual "used" on `completed`.

## 15. Realtime approval queue & audit trail

The approval dashboard subscribes to the org's private `org-<id>:approvals` channel (§3.4);
approve/reject actions are Server Actions that, in one transaction, write the
`approval_actions` row (approver, decision, reason, timestamp), advance `print_jobs.status`,
and append the corresponding `print_job_events` row — then broadcast on the channel so the
queue updates for every connected admin instantly, and disappears from the queue the moment
any admin acts on it. `print_job_events` is append-only (no update/delete policy is granted
to any role beyond service-role) so it remains a trustworthy audit trail for diagnosing a
real-world printing problem after the fact, per spec §41.

## 16. Deployment shape (Vercel + Supabase)

Next.js 16, App Router. Server Actions handle same-origin dashboard mutations; Route
Handlers (`app/api/**`) serve the typed API the Agent calls (register, heartbeat, job
claim/download-url, status report) and admin remote-command issuance — both are equally
valid App Router surfaces, but Route Handlers are used wherever a non-browser client, a
custom auth header, or webhook-style delivery is involved. The browser subscribes to
Supabase Realtime **directly** (not proxied through a Next.js server) using the session
JWT — Vercel's serverless functions cannot hold a persistent connection open anyway, so
realtime fan-out is Supabase's job, and Next.js's job is only to perform the authorized
writes and issue the JWT that makes the client-side subscription possible.

Inbound Agent calls (heartbeat, status reports) are plain authenticated POST Route
Handlers — fast, stateless, idempotent — never a kept-open connection. Periodic sweeps
(expiring stale approval windows/leases, enforcing file retention) run as Vercel Cron
hitting a Route Handler; a straightforward idempotent "scan and expire" pass fits well
within standard function duration limits, so no additional queue/workflow infrastructure is
needed for V1.

**Research basis:** Next.js 16 blog/docs (App Router is the actively developed target,
Pages Router is maintenance-only); Vercel Functions/Cron docs (duration limits, `waitUntil`
semantics, Cron cadence by plan tier); Supabase Realtime Authorization guide.

## 17. Offline & failure recovery

The Agent is designed to never crash on any single failure (printer offline, malformed PDF,
locked file, PowerShell failure, spooler command failure, dropped Supabase connection,
vanished Windows queue, full disk) — each becomes a controlled job state transition to
`failed` with a recorded `error_message`, not an unhandled exception. Retries are bounded
(`max_attempts`, exponential backoff) and the full error history is preserved via
`print_job_events`, never silently overwritten.

If the Agent loses connectivity entirely, it keeps running against its local on-disk queue,
does not lose track of in-flight jobs, and reconciles state with the cloud on reconnect
(comparing its local job records against the cloud's view, resolving conflicts in favor of
whichever side has the more advanced, valid state-machine transition). If the Agent
vanishes mid-job from the cloud's perspective, the job's lease simply expires (§13) — the
cloud does not need the Agent to explicitly report failure for the system to recover.

## 18. Rate limiting

Two endpoints are fixed-window rate limited, both via a single shared Postgres function
(`check_rate_limit`, `supabase/migrations/0012_rate_limiting.sql`): print job submission
(`app/(dashboard)/print/actions.ts`, keyed per user - 20 submissions / 5 minutes) and agent
enrollment (`app/api/agents/register/route.ts`, keyed per source IP - 10 attempts / 5
minutes, slowing down brute-force guessing of an enrollment code). Deliberately **not**
in-memory: `apps/web` runs on Vercel, where a single serverless function is not one
long-lived process, so a module-scope counter has no visibility across instances and would
not actually limit anything under real traffic. A shared Postgres row is centralized and
correct regardless of which instance handles the request; if the hot agent-polling paths
(§4) ever need this too, an external low-latency store (e.g. Upstash Redis) is the natural
upgrade, but isn't required for correctness at this scale. A failure of the rate-limit check
itself fails open (logged, request proceeds) rather than blocking legitimate use on an
unrelated outage - it's defense in depth, not the primary security boundary (that's still
RLS, §3, and the enrollment code's own 48 bits of entropy, §4).

## 19. What this system does not guarantee

Kept short here; the full list with rationale is in
[known-limitations.md](./known-limitations.md). The headline one, because it shapes the
entire job state machine: **PrintOS can confirm a job was accepted by the Windows print
spooler. It cannot, in general, confirm the printer physically produced the pages**,
because most Windows port monitors (standard TCP/IP, most USB) mark a job "printed" as
soon as the spooler finishes transmitting data, not when the device confirms physical
completion — true end-of-job confirmation depends on a vendor-specific bidirectional port
monitor or SNMP polling layered on top, which is model-specific and not assumed present.
`submitted_to_spooler` and `completed` are therefore tracked as distinct, honestly-labeled
states, and the UI/docs never claim a stronger guarantee than that.
