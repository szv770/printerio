# Printio Architecture

This document is the source of truth for how Printio is built and why. It exists because
this system prints real documents on real machines for real students and staff, and every
design choice here was checked against current official documentation before being
implemented (see "Research basis" at the end of each section). Where something cannot be
done reliably, that limitation is stated plainly rather than hidden behind a fake success
state — see [Known Limitations](./known-limitations.md).

## 1. System overview

```
┌─────────────────────┐        ┌──────────────────────────┐        ┌────────────────────┐
│  Browser (student/   │        │      Printio Cloud       │        │  Windows Print      │
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

**Why this shape specifically fits a locked-down campus network.** This system exists
because the alternative — a student's own device joining the same network segment as the
printer — isn't available here: the campus wifi sits behind a captive portal with access
codes that rotate periodically, and the printers live on a separate, wifi-isolated Ethernet
network for security reasons IT controls, not Printio. Nothing in this architecture needs
that to change. The Agent only ever makes *outbound* HTTPS calls to the cloud (poll for
jobs, never a listener — see docs/agent-api.md, and §11's reconciliation model), so it
needs no inbound firewall rule and no VPN into the isolated segment; it just needs to be a
machine that already has a leg on both networks — reachable from the internet (or the
regular campus network) to poll the cloud, *and* on the same Ethernet segment as the
printers to submit to their Windows queues. A browser on the wifi side never needs to
reach the printer network at all — it only ever talks to the cloud, exactly like any other
web app. The captive portal's own login/code-rotation is therefore someone's daily hassle
getting *onto* wifi, not a blocker to printing once they're on it.

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

`organizations.allowed_domains` is enforced as a sign-in gate for brand-new users (see §19)
— but it still grants no membership or role by itself, and it never gates an *existing*
member. This does not weaken the invariant above: passing the domain check gives a
brand-new user nothing but the ability to reach the enrollment-code screen
(`app/no-access`) instead of being signed back out; actual admission is still,
unconditionally, one of the two bootstrap paths above.

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
version, configured printer queues, and an optional self-reported `machine` block
(hostname, OS description, non-loopback IP addresses, and whether the Agent is running from
a real git checkout — `apps/agent/src/machine-info.ts`); the dashboard derives
online/offline from staleness of `last_seen_at` (no persistent connection is required or
held open — see §8). The `machine` values are **display-only**: they exist so an admin can
tell which physical PC a row corresponds to, and nothing in Printio authenticates,
authorizes, or routes on them, which is precisely what makes accepting a self-report safe
(§3.2). The heartbeat *response* carries `paused` back down (§12.2).

## 5. PDF preflight

Every upload is validated server-side before anything else happens:

- MIME type and actual PDF structure are checked (not just the filename/extension).
- Page count is computed by parsing the PDF server-side — the browser-supplied count (if
  any, e.g. from a client-side preview) is never trusted or stored as authoritative.
- File size is checked against a configurable per-organization maximum before the file is
  fully persisted.
- A malformed PDF is rejected with a clear error and a `PREFLIGHT_REJECTED` job event; it
  never reaches the policy engine or storage as a "real" job.

Optional/V1.5: mixed-page-size detection, landscape/portrait detection. These are
explicitly optional and never gate the core upload → print flow. (First-page thumbnail
rendering is built: `lib/pdf/render-page.ts`, used by both the submitter's own preview and
an approver's — §5.2.)

### 5.1 "Where does an uploaded file go, and what stops a virus?" — the plain answer

This section is deliberately written for a school IT administrator rather than for a
developer, because it is the question that actually gets asked. Everything in it is a
statement about code that exists, not an intention.

**Where the file goes, step by step.**

1. A student or teacher picks a PDF in their browser. Before anything is sent, the browser
   checks it locally (size against the organization's limit, the `%PDF-` header bytes, page
   count, and the active-content check below) purely so an obviously-unacceptable file is
   refused in a second instead of after a long upload. None of this is trusted — it is a
   courtesy, and a scripted upload can skip it entirely (`lib/pdf/client-precheck.ts`).
2. The bytes are POSTed to Printio's own server (a Next.js Server Action running on Vercel).
   They exist there only as memory inside that one request. **Nothing is written to a
   disk on the web server** — there is no upload folder, no shared temp directory, nothing
   left behind for a later request to find.
3. That request re-runs every check itself, on the real bytes, and this pass is the only one
   that counts (`lib/pdf/preflight.ts` — §5). A file that fails is refused with a plain
   reason and is never stored anywhere.
4. Only a file that passed is written to Supabase Storage, in a **private** bucket
   (`print-jobs`), under a path scoped to the organization and the job
   (`org/{organizationId}/jobs/{jobId}/original.pdf`).
5. When it is time to print, the on-premises Windows Agent asks the cloud for that one job,
   is handed a **signed URL that expires in 5 minutes**, downloads the file to its own
   folder on that PC, re-checks the `%PDF-` header, and hands it to the Windows print
   queue. Downloaded copies stay in the Agent's own folder on that machine until an admin
   runs `CLEAR_AGENT_TEMP_FILES` (§12) — worth knowing, because that PC's own disk is then
   the one place a print file lingers.

**What is actually checked before a file is accepted** (all of it server-side, all of it
in `lib/pdf/preflight.ts`, tested in `preflight.test.ts`):

- The file is not empty, and is within the organization's configured size limit
  (`organization_settings.max_upload_size_bytes`, 50 MB by default; the bucket also has a
  hard 100 MiB ceiling of its own).
- It really is a PDF — the leading `%PDF-` bytes are checked, not the filename or the
  extension. A `.docx` renamed to `.pdf`, an image, a script, an executable: all rejected
  here, whatever the browser claimed the file was.
- It parses as a structurally valid PDF end to end (pdf-lib), and has at least one page. A
  truncated or corrupted file is rejected, not queued and then mysteriously failed at the
  printer.
- A password-protected/encrypted PDF is rejected with an explanation, rather than being
  stored as something nobody downstream can open.
- The page count is computed here, from the file itself. A number claimed by the browser is
  never stored or used for quota/policy (§3.2).
- **New: the PDF must not declare active content.** A structurally valid PDF can still
  carry an embedded JavaScript action, a `/Launch` action (an instruction to run a program
  or open another file), or an embedded file attachment (the classic way a PDF is used as a
  container to smuggle something else). `lib/pdf/active-content.ts` walks the document's
  parsed object graph — every indirect object, including the ones packed inside compressed
  object streams, which a naive text search over the raw bytes would miss — and a document
  declaring any of the three is **rejected outright**, with a message telling the submitter
  to re-export it via Print → Save as PDF (which drops all three). Ordinary link
  annotations are not affected: a hyperlink is inert on paper and is not treated as active
  content.

**Is there virus scanning? No — and that is a deliberate, stated position, not an
oversight.** Supabase Storage has no built-in malware scanning, and Printio does not run
ClamAV or any third-party AV engine over uploads. Running one would mean either a paid
scanning API in the upload path (a per-file cost and a new failure mode on a volunteer-run
system) or a long-lived machine to host the scanner, which this architecture deliberately
does not have (§16 — everything is serverless plus one on-prem Agent). What Printio does
instead is narrow the attack surface to the point where a scanner would have very little
left to find:

- Nothing on the server ever *opens* the file as a document. The cloud parses its structure
  and counts pages; it never renders it.
- The file reaches its destination as a PDF handed to the Windows print pipeline via
  SumatraPDF. Printer drivers and print spoolers draw page content; they do not execute
  document scripts, and they do not open attachments. Page content — text, vectors, images
  — is not a code-execution channel.
- The three constructs that *could* be acted on later, if a human opened the same file in a
  full PDF reader (JavaScript, `/Launch`, attachments), are now refused at upload rather
  than stored.

**The residual risk, stated honestly.** A malicious PDF that exploits a parser bug in a
specific PDF reader/rasterizer version is still theoretically possible — that class of bug
is what AV signatures catch and structure validation does not. In this system that would
have to be a bug in pdf-lib's parser (server-side, in a short-lived function with no disk
and no credentials beyond that request), in pdfjs-dist (client-side, in the submitter's or
approver's own browser tab), or in SumatraPDF/the printer driver on the Agent PC. That is
the same exposure any school has when a staff member opens a PDF that arrived by email, and
it is bounded here by the two things that matter operationally: keep the Agent PC patched
(Windows, drivers, SumatraPDF), and keep dependencies current. If a school's policy later
*requires* AV scanning of uploads, the natural insertion point is between step 3 and step 4
above — a scan call after preflight passes and before the object is persisted — and that
remains an unimplemented option, recorded in [known-limitations.md](./known-limitations.md)
rather than half-built.

**Can one school (or one student) read another's files?** No, and this is enforced by the
database rather than by application code remembering to filter:

- The bucket is **private** (`public = false`, `0007_storage.sql`). There is no public URL
  for any object in it, so guessing or leaking a path is not enough to read anything — an
  unauthenticated request gets nothing.
- Storage's own row-level security parses the object path and requires the `org/{id}`
  segment to be one of the caller's own active organizations (`private.user_org_ids()`), so
  a member of organization A presenting a valid session and a correct-looking path from
  organization B is refused by Postgres, not by a check somewhere in the app.
- Every download — the Agent's, an approver's preview, a reprint — goes through a
  short-lived **signed URL** (`createSignedUrl`: 5 minutes for the Agent, 2 minutes for a
  browser preview), minted only after the caller's role and the job's ownership have been
  re-derived server-side. Never a permanent or public link.
- Within an organization, file access follows the same rule as the job row itself: your own
  jobs, plus (for an approver/org_admin) the jobs they are responsible for approving. Job
  ids are random UUIDs, so there is no sequence to walk.

### 5.2 Approver preview of the actual document

An approver decides on a real document, not just a filename and a page count, so the
approval queue (`app/admin/approvals/`) shows the submitter, page count, file size, target
printer profile and the full settings line, plus an on-demand preview: `View file` calls
`createJobFileUrlAction`, which re-checks the caller is an `org_admin`/`approver` **of that
job's own organization**, then mints a 2-minute signed URL as that caller (so Storage's
path-scoped policy is an independent third check). Page 1 is rendered in the approver's own
browser from those same bytes (`lib/pdf/render-page.ts`, the renderer the submitter's own
preview uses), and the same URL backs an "Open the original PDF" link for reading the whole
document. Nothing is fetched until an approver asks, so opening a queue of a dozen pending
jobs mints no URLs at all.

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

### 6.5 Admin bypass (opt-out, not a code path in the engine itself)

An `org_admin`'s own submission is exempt from a `deny`/`require_approval` outcome and from
quota blocking by default (`organization_settings.admins_bypass_restrictions`, default
`true` — `0021_admin_bypass_restrictions.sql`). The rationale: an org frequently has no
approver besides its own admin, so the fail-safe `require_approval` default (6.3) would
otherwise be able to lock an admin out of their own printer with nobody able to unblock
them. This is deliberately **not** implemented inside `evaluatePolicy()` — the engine still
evaluates and returns exactly what the rules say; `lib/policy/admin-bypass.ts` decides,
in the caller (`print/actions.ts`), whether that outcome is allowed to actually block the
job. `policy_action`/`policy_reasons` are stored unchanged either way; a bypassed job also
sets `print_jobs.policy_bypassed_for_admin`, so the job detail page can show a clear warning
rather than silently overriding what the org's own policy said. Quota is bypassed the same
way — the reserve call passes a `null` limit (always succeeds, still tracked) instead of
skipping the reserve entirely. An organization can turn this off to hold its own admins to
the same rules as everyone else (Admin → Settings).

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

Padding alone is not booklet printing. Printio performs its own real N-up saddle-stitch
**imposition** (`apps/web/lib/pdf/imposition.ts`) on the padded PDF before it is ever
uploaded as `derived_file_path` — the file the Agent downloads and sends to the printer is
already the final, laid-out sheet, not a plain page-sequential PDF left for the driver to
re-flow into a booklet.

**Why not just use the driver's own booklet mode, and what "real imposition" buys over
it:** a Windows print driver's booklet feature picks **one uniform scale factor for the
entire document**, sized so the single worst-case page (e.g. one oversized image or wide
table) fits without clipping — every other, normally-sized page is then forced down to that
same worst-case scale and surrounded by needlessly large margins it never needed. Printio's
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

Because Printio now does its own precise per-page scaling, a booklet job must NOT also ask
the driver to `fit`/`shrink` — that would silently re-scale an already-correctly-sized page
and undo the whole point of imposing it. `ResolvedPrintRequest.fitMode` is set to
`"noscale"` for a booklet job only (`apps/web/app/api/agents/jobs/[jobId]/download-url/route.ts`);
every other job leaves it unset and the Agent falls back to its own machine-level
`PRINTIO_PRINT_FIT_MODE` default, exactly as before this field existed
(`apps/agent/src/orchestrator.ts`). This is a value chosen upstream in the cloud and passed
down through the existing `fitMode` field — it does not change what the Agent's
`print-executor.ts` is allowed to do with it, and that module still never reads `finishing`
off the resolved print request (sec 9-10).

The physical sheet count is unaffected by imposition — `computePrintMath` (sec 7) still
counts `Math.ceil(paddedPageCount / 4)` sheets regardless of whether those 4 padded pages
end up laid out across 2 imposed landscape sides; only what is drawn on each sheet changes,
not how many sheets there are, so quota consumption (sec 14) is unaffected.

**RTL-aware binding side.** `imposeBookletPdf` takes a `bindingSide: "left" | "right"`
parameter (default `"left"`, today's behavior above, unchanged) — naming matches the Kyocera
KX driver's own booklet Layout-tab terminology for this printer family ("Left edge binding"
for LTR text, "Right edge binding" — explicitly documented as intended for RTL text, e.g.
Hebrew — see printer-setup.md §0). `"right"` mirrors which physical half-sheet slot (left vs.
right) each page number lands in, sheet by sheet — the saddle-stitch fold-and-staple hardware
is left/right-symmetric, so mirroring every sheet's slot assignment produces the exact mirror
image of the `"left"` imposition, and reading that mirrored, folded, nested, stapled object in
the mirrored (right-to-left) direction recovers the original page sequence in order, not the
reverse of it (`imposition.test.ts`'s `bindingSide: "right"` tests decode the actual output
PDF's object graph — not just the transform matrices — to prove this concretely for an 8-page
booklet: page identity is tied to each embedded page's own Form XObject `BBox`, not merely
inferred from scale). `bookletPageOrder`'s own sheet order/nesting is untouched either way;
only the left/right slot assignment within each sheet flips.

This is stored per profile (`printer_profiles.booklet_binding_side`, only meaningful when
`declared_capabilities.booklet` is true) with an org-level default to prefill new profiles
from (`organization_settings.default_booklet_binding_side` — defaults to `'left'` for every
existing organization, so this column's addition changes nothing until an org_admin opts in
from `/admin/settings`) and a per-job override in the print form for the occasional exception
(e.g. an RTL-default organization printing one LTR booklet). `createPrintJob`
(`apps/web/app/(dashboard)/print/actions.ts`) resolves the job's own override if present, else
the target profile's stored default, and passes that resolved value straight through to
`imposeBookletPdf` — the driver's own copy of this same Left/Right edge binding toggle is
irrelevant for a Printio booklet queue, since the driver's whole booklet page-layout feature
is already off there (see the callout above), so binding side is entirely a Printio-side
setting, never a driver one.

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

Consequently, Printio does not attempt to program finishing options at print time at all.
Instead:

- An administrator configures each physical printer as one or more **`printer_profiles`**
  rows, each pointing at a distinct, **pre-configured Windows printer queue**
  (`windows_queue_name`) whose driver "Printing Defaults" already bake in that profile's
  finishing options (e.g. `Kyocera_Main` = plain duplex default, `Kyocera_Main_Booklet` =
  booklet+saddle-stitch default, `Kyocera_Main_Stapled` = corner-staple default). Setting
  those defaults is a one-time, on-site, driver-GUI task per queue (documented in
  [printer-setup.md](./printer-setup.md)), not something Printio's software does remotely.
- The cloud never sends a raw Windows queue name to an untrusted client. A print job
  carries a **logical** `printerProfileId`; the Agent resolves it to the actual Windows
  queue name from its own configuration (fetched over its authenticated channel), matching
  the spec's example JSON shape.
- What Printio's Agent *does* control per job, via SumatraPDF's currently-documented
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
  their declared profile against reality, but Printio cannot introspect a driver's private
  DEVMODE finishing state from software, so it does not pretend to.

### 9.1 Admin test prints

Because §9's whole model is "the queue's own driver defaults are the source of
truth, and Printio cannot introspect them," the only honest way to answer "is this
queue actually working?" is to print something through it. An `org_admin` can do
exactly that from Admin → Printers (per profile, next to Refresh status/Restart
queue) or from a queue row on the per-Agent detail page:
`sendTestPrintAction` (`app/admin/printers/actions.ts`) generates a one-page PDF
(`lib/pdf/test-print.ts`) that names the printer, the profile, its Windows queue,
who sent it, when, and the job id — so the sheet in the admin's hand identifies
*which* of several queues on one MFP produced it — and then hands it to the
ordinary pipeline.

**It is deliberately not a parallel path.** After the PDF exists, everything is
the same code a student's essay goes through: the same `preflightPdf` (§5), the
same private, org-scoped `jobFilePath` upload (§3.3), and a real `print_jobs`
row in `approved` — which is precisely what `/api/agents/jobs/claimable` offers,
what the Agent claims and leases, what `/download-url` signs a URL for, and what
the Agent prints through SumatraPDF on that profile's Windows queue (§10-13).
Nothing in the Agent, the job API, or the state machine branches on a test print;
the admin watches it move through the same stepper (§13) on the same job page a
real submission redirects to. A test print requests **no** finishing flags on
purpose — what the queue's Printing Defaults do to it is the thing being tested.

What it skips is only what belongs to a *person's* job:

- **Policy and approval.** An org whose rules require approval (the fail-safe
  default, §6.3) would otherwise be unable to test its own printer without an
  admin approving their own test; worse, a `deny` outcome would make a queue
  untestable. `policy_action` is stored as `null`, not faked as `'allow'` — the
  engine genuinely didn't run, and the stepper says "skipped", not "checked"
  (`lib/job-progress.ts`'s `isTestPrint`).
- **Quota.** Nothing is reserved. That is why `print_jobs.is_test_print`
  (`0024_print_jobs_is_test_print.sql`) must also stop the *completion* path from
  acting: `adjust_monthly_usage` works on the shared per-user `monthly_usage`
  row, so a `consume`/`release` for a job that never reserved anything would both
  record paper nobody asked for and silently eat a reservation still held by one
  of that admin's real pending jobs. Guarded in both places that could do it —
  `app/api/agents/jobs/[jobId]/status` and the mid-flight-failure step of
  `app/api/cron/sweep`.

The same flag keeps a test print out of everything that counts real print
activity: admin Reports (`app/admin/reports`), the platform per-org job count
(`app/platform`), a member's own activity card (`app/admin/users/[userId]`), and
the "Jobs today" tile. Two deliberate exceptions: the admin dashboard's **failed
jobs** count still includes them (a test print that failed is exactly what that
tile exists to surface), and the per-Agent page's per-queue job counts include
them too, since those really were jobs sent to that queue and the card is a
diagnostic rather than a usage report — both are stated in the UI rather than
left to be inferred. "Print again" is not offered on a test print, since
reprinting re-runs the ordinary pipeline and would quietly turn it into a real,
quota-charged job.

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

### 10.1 SumatraPDF is validated at Agent startup, not at print time

SumatraPDF is the single, unconditional submission path for **every** job — there is no
per-printer-profile "needs Sumatra" capability (§9: a profile carries a queue name and
finishing defaults, nothing about how the bytes get there). So "SumatraPDF is missing or
broken" is not a per-job condition; it is a machine-level configuration fault that makes
every job on that Agent impossible.

`apps/agent/src/dependency-check.ts` therefore runs, in `runStart()`, **before the Agent
polls for a single job** — which is also the installed Windows Service's path, since
`service-launcher.mjs` forces the `start` command and imports the same entry point, so
there is only one place this can happen and no second code path to keep in sync. It:

1. resolves the configured path exactly as `config.ts` does (`PRINTIO_SUMATRA_PATH`, else
   the bare `SumatraPDF.exe` via `PATH`),
2. requires the file to begin with the DOS/PE `MZ` magic — this is what catches a truncated
   download or an HTML error page saved under an `.exe` name, both of which pass a
   file-existence check and then fail at print time, and
3. **actually starts the process** with a harmless argv (`-print-to <randomized synthetic
   queue> -silent <path that does not exist>`) and confirms Windows could load the image —
   which is what catches a wrong-architecture build, an AV stub, or an AppLocker block.

If that fails, **the Agent refuses to start**: it prints a ruled, plain-English block
(matching `setup-agent.ps1`'s `Show-StopMessage` convention, not a JSON log line), writes
the same failure as a structured `error` line to the log file, and exits non-zero. It does
*not* start in a degraded mode that polls and claims jobs, because claiming a real user's
approved job only to fail it destroys work while the dashboard shows a healthy, online
Agent; refusing to start makes the machine honestly, visibly offline and leaves those jobs
claimable. Note the consequence in service mode: the SCM recovery action configured by
`install-service` will keep relaunching it, so a misconfigured machine restart-loops at the
recovery interval, logging the same loud block each time, until SumatraPDF is fixed.

Deliberately conservative: if the process starts **at all**, the check passes — exit code,
stdout/stderr, and even "it had to be killed on a timeout" are all treated as success,
because each proves the only thing being tested. A false "it's broken" would take working
Agents offline, which is worse than the late-discovery bug being closed. `PRINTIO_SKIP_
DEPENDENCY_CHECK=true` is a documented escape hatch for exactly that case, logged loudly on
every startup while it is set. The check makes no claim about whether SumatraPDF then prints
*correctly* — only the physical validation checklist (`apps/agent/README.md`) can establish
that.

`setup-agent.ps1` runs the same three-step check (`Test-SumatraUsable`) at setup time, at
the point where it previously did a bare `Test-Path`, and re-runs it against the portable
build it offers to download — a download that turns out not to be an executable is deleted
rather than saved into `.env`, which is what that same 404-page-as-`.exe` incident produced
once.

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
CLEAR_AGENT_TEMP_FILES  (only files under the Agent's own Printio temp directory)
CHECK_FOR_UPDATE        (no payload at all)
```

Every issuance is authenticated (admin session), authorized (admin must be an org_admin of
the target Agent's organization), recorded in `remote_commands` with the issuing admin id,
and mirrored into `audit_logs`. The Agent's command handler is a `switch` over this fixed
set — there is no code path that accepts or `eval`s an arbitrary string from the cloud. The
set is enforced in three independent places: `REMOTE_COMMANDS` in `packages/shared`, the
`remote_commands.command` CHECK constraint in Postgres, and the Agent's own `switch`.

### 12.1 `CHECK_FOR_UPDATE` and why adding it doesn't weaken the above

`apps/agent` is a locally-run Node app on the school's Windows machine; the cloud cannot
push a binary to it. Its only real self-update path is the `git pull` inside
`apps/agent/scripts/setup-agent.ps1`, which today only runs when someone is physically at
the machine re-launching that script. `CHECK_FOR_UPDATE` runs that *same* sequence on
demand (`apps/agent/src/self-update.ts`), and is a fixed command name for exactly the same
reason every other entry is:

- **It carries no payload and reads none.** `RemoteCommandPayload.CHECK_FOR_UPDATE` is
  `Record<string, never>`, and the handler passes nothing to the updater. There is no
  branch, remote, path, flag, or command string that can travel from the cloud into a
  process invocation — a test asserts the updater is invoked with zero arguments even when
  the payload is deliberately hostile.
- **Two hardcoded argv arrays, `shell: false`:** `git pull --ff-only` and `<pnpm> install`,
  both in the Agent's own checkout directory (computed from its own module path, never
  supplied). `--ff-only` rather than setup-agent.ps1's bare `git pull`: an unattended
  update must either fast-forward cleanly or refuse, never invent a merge commit on a
  machine nobody is watching.
- **It refuses to pretend.** With no `.git` at the repo root (the Downloads-ZIP case) it
  acks back a specific `not_a_git_checkout` result whose message tells the admin to re-run
  `setup-agent.bat`, rather than silently doing nothing. Same for git being absent, the
  pull being rejected, or `pnpm install` failing — each is a distinct, admin-facing reason,
  and none of them restarts the Agent.
- **The restart is the existing mechanism.** On a successful update it reuses
  `scheduleServiceRestart` — the same controlled exit `RESTART_AGENT_SERVICE` already uses,
  which acks first and lets the Service Control Manager's recovery action relaunch the
  process. No new restart path.

The console pairs this with a compare-target so the version string means something:
`LATEST_AGENT_VERSION` in `packages/shared` is what this repository ships (both deployables
depend on that package; `apps/web` cannot import `apps/agent`), and
`apps/agent/test/self-update.test.ts` fails the build if it ever drifts from
`apps/agent/package.json`'s own version.

### 12.2 Pausing an Agent

`agents.paused` holds an Agent back from taking **new** work without revoking its
credential. It is enforced in the cloud, in the two routes that hand out work:
`/api/agents/jobs/claimable` returns an empty list and `/api/agents/jobs/:jobId/claim`
refuses with `409 agent_paused`, both read from `authenticateAgentRequest`'s result so no
route can forget the check. The Agent is *also* told `paused: true` in its heartbeat
response and stops polling — but that is an optimization, not the mechanism: an older or
modified Agent that ignores it still gets nothing.

Deliberately distinct from `status = 'disabled'`, which revokes the credential outright (a
disabled Agent can't even heartbeat, so it vanishes from the dashboard). And deliberately
*not* something that touches jobs already leased: those finish printing normally. Pausing
stops new work; it does not abandon work in flight. The UI reflects the same distinction —
a paused Agent's queues read "Paused by admin", never "offline"/"error", because a
deliberately held queue is not a broken one.

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

**The same state machine is what the submitter sees.** `apps/web/lib/job-progress.ts`
projects the 14 states above onto seven user-facing stages — submitted → checked against
print rules → approval → waiting for a printer → sent to the printer → printing → done —
and the job detail page renders them as a stepper (which stages are done, which one the job
is on right now, which are still ahead), with the plain-English event log
(`lib/job-event-labels.ts`) kept underneath as the detail. The projection is derived from
`packages/shared/src/job-state.ts`, not re-invented alongside it:
`lib/job-progress.test.ts` walks `JOB_STATES`/`ALLOWED_TRANSITIONS` and fails if a state
loses its stage, if an event type stops being classified, or if any allowed transition would
move the stepper *backwards* (except the two rewind edges the machine documents by name —
lease expiry and retry). A job that stopped is placed at the stage its own
`print_job_events` rows prove it reached, since `failed`/`expired`/`cancelled` are reachable
from several points, and it says *why* using what was actually recorded for it
(`policy_reasons`, the approver's reason, `error_message`, `attempt_count`/`max_attempts`) —
never a bare "failed". There is deliberately **no percentage anywhere**: nothing in this
system observes page-by-page printer progress (§20), so discrete stages are the only honest
unit of progress. Both the detail page and the jobs list update live through the same
`postgres_changes`-on-`print_jobs` subscription the approval queue uses (§3.4/§15), paired
with a `router.refresh()` so server-derived detail (the event trail, the approver's reason)
follows the status change rather than lagging behind it.

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
within standard function duration limits (`export const maxDuration = 60` on the route),
so no additional queue/workflow infrastructure is needed for V1.

**Round-trip shape at scale.** Each sweep step is one capped SELECT (`LIMIT 500`, ordered
oldest-first) followed by one batched `UPDATE ... WHERE id IN (...) RETURNING id`, then one
bulk `print_job_events` insert built only from the ids the UPDATE actually returned (never
the ids the SELECT started with — a job that transitioned away in between is excluded, not
stale-recorded) — see `apps/web/lib/cron-sweep.ts`. Quota releases are batched per distinct
(organization_id, user_id) via `groupQuotaReleases`, one `adjust_monthly_usage` RPC call per
group instead of per job — safe specifically because `release`'s clamped subtraction
(`greatest(0, reserved - amount)`) commutes with summing amounts first. The retention
sweep's per-job `storage.remove()` calls are similarly collapsed into one call per
org/retention-window batch. `print_jobs.files_purged_at` (set once a job's Storage objects
are removed, filtered via `is null` in the retention SELECT) is what makes repeat ticks
cheap rather than wasted work — a job whose files are already gone is never reselected
again. Every LIMIT is a re-query by state/timestamp, never an offset/cursor, so a tick that
hits its cap simply makes partial progress and the next scheduled tick picks up the rest.

### 16.1 Retention has one implementation, and three ways to trigger it

The retention pass itself lives in `apps/web/lib/retention.ts`, not in the cron route, because
three callers share it and must not drift into three different notions of "delete a job's
files":

1. **The scheduled sweep** (`app/api/cron/sweep/route.ts`) — every organization, every
   window, on a timer.
2. **An admin's "clean up now"** (`app/admin/storage/`) — the *same* pass, scoped to one
   organization, run on demand. Deliberately not more aggressive than the scheduled one: it
   removes exactly what the timer would already remove (terminal jobs past that org's
   configured window), so the number the page shows as "ready to clean up" is by
   construction what the button deletes. It runs as the calling admin, not as service-role
   — Storage's delete policy already admits an org_admin for their own org's path prefix and
   `print_jobs`' update policy admits them via `private.is_org_approver`, so RLS stays the
   enforcement point end to end.
3. **A user deleting their own finished job's file early**
   (`app/(dashboard)/jobs/[id]/actions.ts`) — for the submitter who would rather not leave a
   copy of their document sitting in the cloud for the rest of the retention window.

The invariant all three inherit from that module: **only Storage objects are ever removed;
the `print_jobs` row always survives** (job number, page/sheet counts, quota history and the
`print_job_events` trail are what an audit needs after the file is gone). There is
deliberately no `delete` policy on `print_jobs` for any user role, precisely so nobody can
erase their own history by "deleting a job".

Eligibility for the user-initiated case is stricter than the sweep's and is one pure,
unit-tested function (`canOwnerPurgeFiles`): the job must be in a genuinely terminal state
(`completed` / `rejected` / `denied` / `cancelled` / `expired`), and a `failed` job only once
its retry budget is exhausted — `failed → claimed` is a legal transition (§13), so a job that
can still be retried keeps its file. An in-flight or still-pending job can never have its file
pulled out from under the Agent or the approver. The action re-reads the live row (scoped to
`created_by = caller` and their own organization) and re-checks it against that function;
nothing is decided in the browser. The removal itself goes through service-role for this one
path only, because Storage's delete policy admits org_admins alone and a student deleting
their own file is exactly the case it does not cover — safe because no path ever comes from
the client: the object paths are read off the verified row and handed to the same
`purgeJobFiles()` the sweep uses.

`/admin/storage` also answers "how much is this costing us in space": total bytes/files
currently stored, how much is already past its window, how much belongs to jobs still in
flight, and a per-window breakdown, computed by `lib/storage-usage.ts` from the *same*
retention definitions (`summarizeStorageUsage` is pure and unit-tested). Two honest caveats
the page states itself rather than hiding: the figures come from `file_size_bytes`, which
records the uploaded original only (a booklet job's generated print-ready copy has no
recorded size, so the total is a floor), and the page reads a capped number of job rows —
only ones whose files still exist, which retention keeps to a few days' worth — and says so
if it ever hits the cap.

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

## 19. Domain-restricted sign-in & forced re-authentication

This organization is a single Google Workspace domain (a school). Two access controls were
added on top of the base auth flow (§2), both enforced server-side and both configurable/
auditable rather than hardcoded:

### 19.1 Domain restriction on sign-in

`organizations.allowed_domains` (previously a UX-hint-only column, §2.2) is now checked in
`app/auth/callback/route.ts`, right after `exchangeCodeForSession` succeeds, via a
Postgres function (`email_domain_allowed()`, `supabase/migrations/0013_*.sql`). The check
is deliberately narrow:

- **Existing members are never gated by domain.** `email_domain_allowed()`'s first check is
  "does this user already have an active `organization_members` row?" — if so, it returns
  `true` unconditionally. An admin may have deliberately invited someone outside the usual
  domain, or the allowed list may have been tightened after that person already joined;
  either way, domain-check gates *new* joins, it does not silently lock out someone already
  in.
- **A brand-new user with no membership row** is checked against every organization's
  `allowed_domains`: allowed if any organization either lists that domain or has not
  configured a restriction yet (empty array — the schema default). Passing this grants
  nothing beyond reaching `app/no-access`'s existing enrollment-code flow; failing it signs
  the user out immediately and redirects to `app/no-access?reason=domain_not_allowed`, a
  distinct, specific explanation rather than a generic error.
- **The check is SECURITY DEFINER and argument-less**, reading the caller's own
  `auth.uid()`/email server-side rather than trusting a client-supplied email (§3.2's "never
  trust client-supplied identity", applied to email too) — and it has to be SECURITY
  DEFINER because a brand-new user cannot `SELECT` the `organizations` table under RLS
  (that policy requires membership) to check the list themselves.
- **It fails open on an unexpected DB error** (logged, sign-in proceeds) — the same
  philosophy already documented for `check_rate_limit` (§18): this is a narrower gate on top
  of RLS/invitations, not itself the security boundary, so an unrelated outage here must not
  lock out every legitimate user.
- **Bootstrap seeds it automatically.** `maybeBootstrapOrganization` (`lib/auth/bootstrap.ts`)
  sets the first organization's `allowed_domains` from `PRINTIO_BOOTSTRAP_ADMIN_EMAIL`'s own
  domain (e.g. `svogel@lecfl.com` → `['lecfl.com']`), so the single-org case is restricted
  out of the box with no additional env var and no manual admin step. An org_admin can widen,
  narrow, or clear this list afterward from `app/admin/settings` (`allowed_domains` is still
  just a `text[]` column, edited through the ordinary `organizations` RLS update policy — no
  new table, no new RLS pattern).

### 19.2 Forced re-authentication every 30 days

Supabase's own Google-OAuth session refreshes silently forever via the refresh token — there
is no built-in "expire the session for real after N days" primitive, so this is an explicit
timestamp check independent of Supabase's own token expiry:

- `profiles.last_authenticated_at` is set to `now()` in exactly one place:
  `app/auth/callback/route.ts`, immediately after a real `exchangeCodeForSession` succeeds
  (and only for a sign-in that passed the domain gate above). This is deliberately the only
  writer — the silent background token refresh that runs on every request
  (`proxy.ts`/`lib/supabase/middleware.ts`) calls only `supabase.auth.getUser()`, which never
  calls `exchangeCodeForSession`, so it cannot reset this clock. Getting this backwards (e.g.
  updating it on every page load) would mean the 30-day cap never actually bites — this was
  checked against how `@supabase/ssr`'s server client behaves before relying on it.
- The check itself (`lib/auth/reauth.ts`'s `isReauthRequired`, unit tested) is pure: given
  `lastAuthenticatedAt` and `now`, it returns whether more than 30 days have elapsed. A
  `null`/unparseable timestamp is treated as expired (fail closed) — the 0013 migration
  backfills every existing profile to `now()` at deploy time specifically so this doesn't
  immediately force-log-out the entire existing user base.
- **Enforced in exactly one place:** `lib/auth/session.ts`'s `getCurrentSession()`, right
  after the profile row is loaded. Every Server Component/Server Action/Route Handler that
  needs the current user flows through `getCurrentSession` (directly, or via
  `requireSession`/`requireOrgRole`, which both call it) — this is what makes it a single
  point of enforcement instead of a per-route check that's easy to forget on a new route.
  When expired, it calls `supabase.auth.signOut()` and `redirect("/login?reason=reauth_required")`
  — a labeled reason the login page reads and displays, not a bare unexplained logout.
- **Enforced at the database layer too, not just app code:** a security audit found that the
  app-level "only one writer" claim above was not actually true at the RLS layer — the
  ordinary `"users can update own profile"` policy (sec 3, `id = auth.uid()`) restricts which
  *row* a user can touch, not which *columns*, so any authenticated client could otherwise
  re-stamp their own `last_authenticated_at` from browser JS and never be forced back through
  re-authentication. `supabase/migrations/0016_protect_last_authenticated_at.sql` closes this
  with a `before update` trigger (mirroring the existing `platform_role` protection in sec 3)
  that rejects any change to the column unless the calling role is `service_role` — the one
  legitimate writer (`app/auth/callback/route.ts`, via `createServiceRoleClient()`) is
  unaffected; every other path is rejected outright rather than relying on convention.

### 19.3 Magic-link sign-in and its own per-organization toggle

Supabase magic-link (email OTP) sign-in is a second sign-in method, alongside Google OAuth,
offered from `app/login` (`MagicLinkForm.tsx`, next to `SignInButton.tsx`'s existing Google
button). It calls `supabase.auth.signInWithOtp({ email, options: { emailRedirectTo } })` with
the same `redirectTo` construction Google OAuth already uses, and always shows a generic
"check your email" confirmation — Supabase's OTP API deliberately never tells the client
whether the email exists or is disallowed, so there is nothing to branch on client-side; the
actual access decision happens later, when the emailed link is clicked and lands back at
`app/auth/callback/route.ts`.

- **A new, independent gate function — not a change to `email_domain_allowed()`.** Google
  OAuth's gate stays exactly as documented in §19.1, unchanged, always enforced, no toggle.
  Magic-link sign-ins instead call `email_domain_allowed_for_magic_link()`
  (`supabase/migrations/0014_*.sql`), which copies `email_domain_allowed()`'s first two checks
  verbatim (existing active member → always true; no organization exists yet → always true,
  the bootstrap carve-out) and only diverges on the actual per-org domain check.
- **`organizations.magic_link_requires_allowed_domain`** (boolean, default `true`) lets an
  org_admin turn that per-org domain check off for magic-link specifically, from
  `app/admin/settings`. Default `true` means every organization — including every one that
  existed before this feature shipped — keeps exactly the restriction it already had; nothing
  becomes more open until an org_admin explicitly opts out. The multi-org combination rule
  mirrors `email_domain_allowed()`'s existing OR-across-organizations shape: allowed if ANY
  organization either has the toggle off (unconditional allow for magic-link purposes) or has
  it on and would allow the domain via its `allowed_domains` list (empty = unrestricted).
- **The provider-detection problem.** The callback route has to know, precisely, which method
  produced a given `exchangeCodeForSession` result before it can pick the right gate function.
  `data.user.app_metadata.provider` looked like the obvious field, but per `@supabase/auth-js`'s
  own type (`UserAppMetadata.provider` — "the first provider that the user used to sign up
  with") it's a lifetime property of the account, not of this specific sign-in: an account that
  first signed up via Google and later also linked a magic-link identity would keep reporting
  `"google"` forever, even on a sign-in that just used magic link. `lib/auth/provider.ts`
  instead reads `data.user.identities[]` (each carrying its own `provider` and
  `last_sign_in_at`) and picks whichever identity has the most recent `last_sign_in_at` —
  Supabase stamps that field fresh, on the specific identity actually used, on every
  successful code exchange, which is what makes it an accurate answer to "which provider did
  *this* sign-in use" rather than "which provider did this account ever use."
- **Same invariant as §19.1's, unchanged for this method too:** passing either gate grants no
  `organization_members` row, no role, nothing. It only decides whether a brand-new user
  reaches `app/no-access`'s existing enrollment-code flow instead of being signed back out
  immediately — actual admission remains, unconditionally, the `organization_invitations`
  flow.
- **Manual dashboard step required:** Supabase's Email auth provider must be enabled
  (Authentication → Providers → Email) for `signInWithOtp` to work at all — see
  [deployment.md](./deployment.md) §2.

## 20. What this system does not guarantee

Kept short here; the full list with rationale is in
[known-limitations.md](./known-limitations.md). The headline one, because it shapes the
entire job state machine: **Printio can confirm a job was accepted by the Windows print
spooler. It cannot, in general, confirm the printer physically produced the pages**,
because most Windows port monitors (standard TCP/IP, most USB) mark a job "printed" as
soon as the spooler finishes transmitting data, not when the device confirms physical
completion — true end-of-job confirmation depends on a vendor-specific bidirectional port
monitor or SNMP polling layered on top, which is model-specific and not assumed present.
`submitted_to_spooler` and `completed` are therefore tracked as distinct, honestly-labeled
states, and the UI/docs never claim a stronger guarantee than that.
