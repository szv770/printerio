# IPP gateway: contract between `apps/gateway` and `apps/web` (MVP: Windows 11 + Android)

Status: **agreed 2026-10-22 (owner: "up and running good, even just Android and Win11", two agents at a time).**
Read with [the setup design](./2026-10-20-printio-setup-design.md) (phases, principles) and
[ipp-printing.md](../../ipp-printing.md) / [kyocera-raw-print.md](../../kyocera-raw-print.md) (what devices send,
proven printer settings). Two people implement the two halves in parallel; **this file is the interface**. If a side
must deviate, change this file in the same commit and say so loudly.

## Scope (MVP) and principles

- Devices: Windows 11 (Create-Job + Send-Document) and Android (Print-Job). Both send **PDF**. Apple/iOS later.
- Accept everything at the IPP layer, decide server-side with a readable reason (see design doc). Never guess finishing.
- Printer advertised to the OS: monochrome, Letter default, `sides` one-sided / two-sided-long-edge / two-sided-short-edge,
  copies 1-99, page-ranges, **`finishings`**: none, staple-top-left, staple-top-right, saddle-stitch, booklet-maker (see the mapping table; booklet is held
  for a left/right binding choice). Start from `tools/ipp-spike/server.mjs` `printerAttrs` (it is proven to be accepted by Windows and Android) and
  keep `document-format-supported` the same list; clients chose PDF every time.
- Out of scope here: stamp (Phase 3), finishings advertising (Phase 4), Apple profile, Admin cleanup (Phase 6), the My devices /
  Admin > Devices pages (a later PR, built against the tables this PR creates).

## Names and environment

| Thing | Value |
|---|---|
| Web env (new) | `GATEWAY_SHARED_SECRET` (min 32 chars), `GATEWAY_BASE_DOMAIN` (e.g. `szvtech.org`) |
| Gateway env | `WEB_BASE_URL`, `GATEWAY_SHARED_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BASE_DOMAIN`, `PORT` (default 8631), `PRINTER_NAME` (default `Printio`) |
| Auth gateway -> web | `Authorization: Bearer <GATEWAY_SHARED_SECRET>` on every `/api/gateway/*` call; compare in constant time; 401 otherwise |
| Storage bucket | existing `print-jobs`; gateway uploads originals to `gateway-intake/<deviceId>/<uuid>.pdf` with the service-role key; web deletes the intake object after it has stored its own copy via the normal pipeline |

## Device token and hostname

- A device's address is `https://u-<token>.<BASE_DOMAIN>/ipp/print`. `<token>` = 24 random bytes, base32 (RFC 4648 alphabet,
  lowercase, no padding) = **39 chars**; label `u-` + 39 = 41 chars (< 63). Regex: `^u-([a-z2-7]{39})\.`.
- Only `token_hash` = lowercase hex SHA-256 of the 39-char token string is stored. The raw token is shown to the member once at
  creation. The IPP URL path is ignored (Android uses `/ipp/print`, Windows whatever was pasted). Identity = the Host header.
- Cloudflare terminates TLS; the gateway speaks plain HTTP and reads `Host` and `X-Forwarded-Proto`.
- Shared helpers **already exist** in `packages/shared/src/device-token.ts`, imported as `@printio/shared/device-token` (a subpath export,
  NOT in the package index, because it uses node:crypto and a client component imports the index): `generateDeviceToken()`,
  `hashDeviceToken(token)`, `tokenFromHost(host, baseDomain)` (token or null), `deviceHostname(token, baseDomain)`, `isDeviceToken`. Do not rewrite them.

## Database (web side, migration `0032_member_devices.sql`; mirror into `supabase/schema.sql` and `lib/database.types.ts`)

Follow CLAUDE.md: explicit `grant ... to authenticated, service_role` per table, never anon; RLS is the row layer.

- `member_devices`: `id uuid pk`, `organization_id`, `user_id` (the member), `name text`, `device_type text`
  (`windows|android|chromebook|iphone|mac|other`), `token_hash text unique`, `created_at`, `revoked_at null`,
  `first_seen_at null` (gateway saw it), `last_seen_at null`, `last_user_agent text null`, `first_job_at null`,
  `first_printed_at null`. A member sees/creates/revokes their own rows; org admins see all rows of their org (never `token_hash`
  to the browser: use a column-limited view or never select it client-side). Service role does everything.
- `device_events`: `id`, `device_id` fk cascade, `type text`, `user_agent text null`, `detail jsonb`, `created_at`; admins read for
  their org, members for their devices; service role writes. Keep it small (the web may prune beyond 200 rows/device).
- `device_issues` ("I'm having trouble"): `id`, `device_id`, `kind` (`cant_add|nothing_prints|prints_wrong|other`), `note`,
  `status` (`open|resolved`), `resolved_by null`, `resolved_note null`, `created_at`, `resolved_at null`.
- Jobs from the gateway are normal `print_jobs` rows with `source = 'ipp'` (add the column if it does not exist, default
  `'web'`), plus nullable `device_id` fk and `ipp_user_agent`.

## HTTP API (web side, Route Handlers under `apps/web/app/api/gateway/`)

All bodies JSON. Errors: `{ "error": "<code>", "message": "<plain words>" }`.

1. `POST /api/gateway/device/resolve` `{ tokenHash }` ->
   `200 { deviceId, userId, organizationId, displayName }` | `404 {error:"unknown_device"}` | `403 {error:"revoked"}` | `403 {error:"inactive_member"}`.
   Side effects: set `first_seen_at` (if null) and `last_seen_at`. Gateway may cache a positive answer for 60 s.
2. `POST /api/gateway/events` `{ deviceId, type, userAgent?, detail? }` -> `204`. `type` in
   `attributes_requested | job_received | job_rejected | info`. Updates `last_seen_at` / `last_user_agent`; sets `first_job_at` on the
   first `job_received`; appends `device_events`.
3. `POST /api/gateway/jobs/finalize`
   `{ deviceId, storagePath, fileName, sizeBytes, ipp: { jobName?, userAgent?, ippVersion?, attributes } }` where `attributes` is the
   flattened IPP job-template object exactly as the spike's `flatten()` produces it (`copies`, `sides`, `page-ranges` as `[lo,hi]` pairs
   or array of them, `media`, `media-col`, `orientation-requested`, `print-color-mode`, `print-quality`, `finishings`, `document-format`...) ->
   `200 { jobId, jobNumber, status, message? }` where `status` is a `JobState` from `packages/shared/src/job-state.ts`
   (`held`, `pending_approval`, `approved`, `denied`, ...). The web downloads the object from storage (service role), maps the IPP
   attributes to `PrintChoices` (rules below), runs the **same pipeline as the website** (preflight, rate limit, policy, quota,
   approval, stamp later) as the member `userId` on the org's first active raw-mode printer profile, then deletes the intake object.
   Never throws on bad input: an unmappable request still creates the job as `held` with a readable `held_reason`; a file that fails
   preflight returns `422 {error:"bad_pdf", message}` (gateway turns it into an IPP client error) and creates no job.
4. `GET /api/gateway/jobs/<jobId>?deviceId=<id>` -> `200 { jobId, status, message? }` (404 if the job is not that device's).
5. `POST /api/gateway/jobs/<jobId>/cancel` `{ deviceId }` -> `200 { status }` (only held / pending_approval / approved can be cancelled).

## IPP attributes -> `PrintChoices` (web, one pure function, table-tested: `apps/web/lib/gateway/ipp-choices.ts`)

Output: `{ choices: PrintChoices, heldReason: string | null }`. Anything not listed holds, with a sentence the member can act on.

| IPP | Rule |
|---|---|
| `copies` | 1..99 -> copies; otherwise hold ("copies must be 1 to 99") |
| `sides` | `one-sided` -> single; `two-sided-long-edge` -> double (proven long edge); `two-sided-short-edge` -> **hold** ("flip on the short edge is not available from the print dialog yet; choose double-sided or use the website"); absent -> single |
| `page-ranges` | pairs -> text like `1-5, 8` (empty = whole document); invalid -> hold |
| `media`, `media-col` | Letter only (`na_letter_8.5x11in`, or media-size 21590x27940 within 100); anything else -> hold ("paper size X is not available yet") |
| `finishings` | absent or `3` none OK. `4` staple and `20` staple-top-left -> staple top-left; `22` staple-top-right -> top-right (staple needs portrait and no short-edge flip, else hold). `13` booklet-maker and `8` saddle-stitch -> **hold** with "Booklet: choose left or right binding." and booklet kept (sides forced double-sided); the member picks Left or Right on the job page (`finishHeldBookletAction`) and the job is re-created from the original and the held one cancelled. A booklet plus a staple, several staple corners, or any other value (e.g. `28`) -> hold, nothing promised |
| `orientation-requested`, `print-quality`, `print-color-mode`, `printer-resolution`, `print-scaling` | ignored (printer defaults; PDF carries orientation) |
| `document-format` | gateway rejects anything but `application/pdf` (see below); web re-checks `%PDF-` via preflight |
| `job-name` | file name `<name>.pdf` (sanitized: letters, digits, space, `._-`, max 60) |

Booklet and staple are **never** produced by this mapping in the MVP. `createPrintJob` therefore needs a way to be told "create
this job as held with this reason" (`forcedHeldReason`), reusing its existing held path.

## Gateway behaviour (`apps/gateway`)

- Operations: Get-Printer-Attributes (honour `requested-attributes`), Validate-Job, Print-Job, Create-Job, Send-Document,
  Get-Job-Attributes, Get-Jobs, Cancel-Job; everything else `server-error-operation-not-supported`. Keep the spike's compatibility
  details: any URL path, chunked bodies and `Expect: 100-continue`, advertised `printer-uri-supported` built from `Host` +
  `X-Forwarded-Proto`, request-id echoed, charset/language attributes first.
- Unknown / revoked device -> IPP `client-error-not-authorized` (0x0401) for jobs; for Get-Printer-Attributes of an unknown host,
  answer 404 HTTP (no information leak). If the web API is unreachable or 5xx: IPP `server-error-temporary-error` (0x0506) so clients retry;
  never lose a received PDF silently.
- Print-Job / Send-Document: reject a non-PDF `document-format` with `client-error-document-format-not-supported` (0x040A) after
  recording a `job_rejected` event; otherwise upload the bytes, call `finalize`, and answer with the job (id, uri, state).
  Create-Job returns a job in `pending-held` until Send-Document arrives (keep per-device create-job state in memory with a 10 min TTL).
  Limit body size to the org's upload limit (default 50 MB) with a clean IPP error, not a crash.
- Events: `attributes_requested` on Get-Printer-Attributes (throttle to one per device per minute), `job_received`, `job_rejected`.
- Job state mapping (`JobState` -> IPP `job-state`, `job-state-reasons`, plus `job-state-message` = web `message`):
  `draft|held|pending_approval` -> 4 pending-held, `job-hold-until-specified`; `approved|claimed|downloading|downloaded` -> 3 pending,
  `job-queued`; `printing|submitted_to_spooler` -> 5 processing, `job-printing`; `completed` -> 9, `job-completed-successfully`;
  `cancelled` -> 7, `job-canceled-by-user`; `denied|rejected|expired|failed` -> 8 aborted, `aborted-by-system`.
- Must not crash: a malformed request gets an HTTP 400/IPP bad-request, an unhandled error is logged and answered with
  `server-error-internal-error`; the process stays up (the spike only proved 24 h on a Pi; this must run as a Windows service
  with auto-restart, mirroring how `apps/agent` is installed).

## Acceptance (what "done" means for this PR pair)

1. All tests green: `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build` (CI runs exactly these).
2. A scripted end-to-end test: gateway server + fake web API + fake storage; replay the spike's recorded Windows and Android request
   shapes (Get-Printer-Attributes, Create-Job + Send-Document, Print-Job) and assert the uploads, finalize calls, and IPP replies.
3. Token round trip: `generateDeviceToken` -> `deviceHostname` -> `tokenFromHost` -> `hashDeviceToken` matches the stored hash.
4. Owner then tests on real devices (Windows 11, Pixel 8) with labelled prints; nothing is claimed working before that.

## Web-side details added while implementing (additions, nothing above changed)

- Extra error codes the gateway should map to a plain IPP client/server error, never a crash: `finalize` can also answer
  `403 quota_exceeded`, `429 rate_limited`, `503 no_printer` (no active raw printer profile yet; retryable), `404 intake_not_found`,
  `400 invalid_request` (bad body, or `storagePath` not under `gateway-intake/<deviceId>/`), `500 internal_error` (retryable; the intake
  object is kept). Every other 4xx and a successful answer delete the intake object. `bad_pdf` also covers "over the upload limit".
- `deviceId` endpoints answer `403 revoked` / `403 inactive_member` / `404 unknown_device` like `device/resolve`. `GET jobs/<id>` does not
  check revocation (a revoked device can still read what it already sent); `404 unknown_job` for a job that is not that device's.
  `cancel` answers `409 not_cancellable` outside held / pending_approval / approved.
- `finalize` 200 body also carries `jobNumber`, which is the web app's TEXT job number (e.g. `JOB-2026-000002`), display only. IPP job ids are integers, so the gateway issues its own id for jobs that arrive without a Create-Job; Create-Job jobs keep the id handed out at Create-Job time; `message` is the held reason, the first policy reason (denied), or a short note.
- `storagePath` must match `gateway-intake/<deviceId>/<file>` where `<file>` is letters, digits, `.`, `_`, `-` (the contract's `<uuid>.pdf` fits).
- `page-ranges` with an upper bound of 2147483647 ("to the end") becomes `N-`. A range the document does not have holds the job.
- Job names: `ipp.jobName` (else `fileName`) becomes the stored file name.
- Phone-visible job status (no web change needed): `GET jobs/<id>` and `finalize` already carry `message` for held (the held reason text), denied (first policy reason) and failed. The gateway (`apps/gateway/src/job-messages.ts`) turns state + that text into the IPP `job-state`, `job-state-reasons` and a short plain `job-state-message` (< 100 chars) on Get-Job-Attributes / Get-Jobs, and the same text as `status-message` on the Print-Job / Send-Document reply. It recognises a held reason by its wording in `lib/gateway/ipp-choices.ts` (booklet binding, short edge, paper size, copies, page range, sides, finishing); an unrecognised held text falls back to "Open Printio > My jobs to choose how to print this". If those sentences are reworded, update `HELD_KINDS` there. Finished jobs (completed / cancelled / denied / rejected / expired) are no longer looked up again by the gateway; `failed` is still polled because the web can retry it.

### Reliability batch (2026-10-23): waiting jobs, duplicate protection, status cache, busy guard

- **Waiting for the printer.** A queued job that the Print Agent could not hand to the printer (off, offline, unreachable, unknown
  cause) stays `approved` and carries a marker in `error_message` (`[printio:waiting v1 since=... tries=... kind=...] <sentence>`, see
  `docs/agent-api.md` "release"). `GET jobs/<id>` then also answers `waiting: "unavailable" | "unknown"` and `message` = the plain
  sentence; the key is absent for every other job. The gateway shows `job-state` 3 (pending), reason `job-queued` and a short
  `job-state-message`: "Waiting for the printer - it is off or offline" / "Waiting for the printer - status unknown" (plain "Waiting
  for the printer" when no kind is given). It is never `aborted`. After the window (default 2 h) the job is `failed`; `message` for a
  failed job is now the web's plain sentence (never the raw agent text or the internal `[printio:gave-up]` marker).
- **Duplicate protection (gateway).** Key = device id + SHA-256 of the PDF bytes + the print-affecting job attributes (copies, sides,
  media, media-col, page-ranges, finishings, print-color-mode, print-quality, orientation-requested, number-up, output-bin,
  multiple-document-handling, print-scaling; per-attempt noise such as `job-uuid` is ignored). The key is registered BEFORE the
  upload, so a retry that arrives while the first request is still being processed joins the same in-flight work. Within 3 minutes
  an identical request gets the earlier result: no second upload, no second `finalize`, a normal success with the same web job (a
  repeat Print-Job gets the same IPP job-id; a repeat Send-Document fills in its own Create-Job id with the same web job). Only
  successes are remembered (a refusal or a failed web/storage call is retried for real and never blocks the next retry); a job that is
  known to be cancelled/failed/denied/rejected/expired is not handed back; Cancel-Job forgets it. Different document, different
  options or a different device are never merged. LRU-capped at 500 entries; the cache holds job ids, never the PDF.
  **Not covered:** a `finalize` that created the job but whose answer was lost (timeout/5xx) cannot be recognised on the retry - the
  web side has no idempotency key or file-hash column (would need a migration) - so that retry creates a second job.
- **Status cache (gateway).** Each job's web status is remembered for 3 s per web job id (concurrent polls share one request, the
  `finalize` answer primes it, Cancel-Job invalidates it and discards an answer that was already in flight). Terminal states are never
  looked up again. Ten phones polling once a second therefore cost about one web request per job per 3 s.
- **Busy guard (gateway).** Uploads (request bodies over 64 KB; small requests such as status polls are never counted or refused) are
  counted from the moment the body starts until the request is completely finished or the client disappears (one idempotent release
  on every path). Over `MAX_INFLIGHT_UPLOAD_MB` (default 150, never below the per-file limit) of total in-flight bytes, or more than
  `MAX_UPLOADS_PER_DEVICE` (default 2) from one device, the gateway drains the body without keeping it and answers HTTP 200 with
  IPP `server-error-busy` (0x0507), `status-message` "The server is busy right now. Please try again in a moment.",
  `Retry-After: 10` and `Connection: close`, and logs a warning. The 50 MB per-file limit (413 / 0x0408) is checked first and is unchanged.
