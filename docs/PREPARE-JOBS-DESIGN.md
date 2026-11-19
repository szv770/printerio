# Prepare jobs: running the PDF steps on the print server (design for P1 and P2)

Status: design, 2026-11-19. Nothing here is built yet except P0 (`packages/pdf`). Companion to `docs/SAAS-LAUNCH-PLAN.md`
(work packages P0-P4) and `docs/PHASE-C-PLAN.md` (the library's server jobs, which this reuses).

## Why
The website is moving to Cloudflare's free plan (10 ms CPU, 128 MB memory per request). Today `createPrintJob`
(`apps/web/lib/jobs/create-print-job.ts`) downloads the uploaded PDF and does preflight, sanitize, page range, booklet
imposition, stamp and the text-fidelity check inside the web request. That cannot run there. Each organization's print server
already runs Node and can run the same code (`@printio/pdf`, P0), so the heavy steps become a job the print server picks up.

## The key decision: do NOT add a "preparing" state to print jobs
`print_jobs` has a strict state machine (`packages/shared/src/job-state.ts`), a database constraint, labels, cancel and retry
logic, the cleanup sweep, admin filters and the agent's own claim protocol. A new state touches all of them.

Instead, **a print job row is created only after preparation succeeds.** Before that there is a small separate record, a
*prepare job*. Everything downstream of "a print job exists" stays exactly as it is today (policy, quota, approval, claim,
print, retry, retention).

```
browser --uploads original--> Supabase Storage (already how it works)
website: intake  --inserts--> server_jobs (kind prepare_pdf, status queued)      [website, cheap]
print server: claims it (only its own organization), downloads the original, runs the PDF steps (@printio/pdf),
              uploads the prepared file, reports the result                        [print server, heavy]
website: finish  --creates--> print_jobs row (policy, quota, approval) as today    [website, cheap]
```

## What the website keeps (cheap, no PDF libraries)
Steps 1-3 of today's pipeline: rate limit and open-jobs cap, printer profile / settings / member lookup, resolving the print
choices and the held reason, the size cap, and recording the original upload. Plus, after the print server reports back:
the sheet limit, policy evaluation, quota reservation, the derived-file path and the `print_jobs` insert (steps 11-14).

## What moves to the print server
Steps 4-10: preflight (inflate guard, page count, sanitize, active-content scan, Type 3 detection, PJL-escape check), Type 3
rasterize, page range, booklet pad and imposition, stamp, text-fidelity check, final PJL guard. These are exactly the functions now in
`packages/pdf`. The print server needs from the website, in the job's payload: the choices, the profile's paper size and
binding side, the stamp settings and the member's user code, and the org upload limit.

## Data model (one migration, written by us, applied by the owner)
`server_jobs` is extended rather than duplicated (it already has claim, lease and expiry):
- `kind` allows `prepare_pdf` besides `library_fetch`.
- `params` allows up to 16 KB for `prepare_pdf` (choices and stamp settings), still 2 KB for library jobs.
- new `source_path` (the original in the `print-jobs` bucket), `result` (jsonb: page count, sheets, flags, derived path, fidelity
  verdict; at most 64 KB), `finished_at`.
- `organization_id` already exists and is **required** for `prepare_pdf` (library jobs are global).
- Indexes for the per-organization claim; RLS: members can read their own org's prepare jobs (so the page can show "preparing");
  only the service role writes. Explicit grants as `CLAUDE.md` requires; mirror into `supabase/schema.sql`.
- The result store is NOT `library_pages` (that is a shared cache every signed-in user can read); prepared PDFs go to
  `prepared/<organization_id>/<job_id>/<uuid>.pdf` in the existing private bucket.

## Routes (new, under `app/api/agents/prepare-jobs/`, agent bearer auth like the other agent routes)
- `POST claim`: oldest `prepare_pdf` job **for the calling agent's organization only** (`authenticateAgentRequest` gives
  `agent.organizationId`); leases it; 204 when none. A different organization's server can never see it (isolation tests cover this).
- `POST [id]/original`: signed download URL for `source_path` (lease required).
- `POST [id]/upload-slot`: signed upload token for a path the server chooses (the D1 pattern in `app/api/gateway/intake/sign`); the agent
  never picks the path.
- `POST [id]/renew`: extends the lease (new; big PDFs outlast 120 s).
- `POST [id]/complete`: `{ result }`; the website then runs the finish step and creates the print job (or records why not).
- `POST [id]/fail`: a plain-language reason; the sender sees it.

## Print server worker (`apps/agent`)
A separate loop modelled on `library-worker.ts`: never inside the print loop, one job at a time, memory-limited, with a timeout,
and a clear failure if the PDF is too big or broken. Printing is never blocked by preparation.

## What people see
- After upload the page says "Preparing your file..." and lists it in My jobs as a *preparing* card (from the prepare job). When it
  finishes, the normal job appears and the card goes away.
- **No print server online:** "Your print server is offline, so I can't prepare this right now. It will continue when the server is
  back." The prepare job stays queued (expiry window longer than the library's 10 minutes, for example 24 hours).
- Things that were inline form errors become plain reasons on the card: invalid page range, booklet padding confirmation, a
  file that is not a PDF, too many pages. Instant advice stays in the browser (page count with the browser's own pdf-lib).
- Page count, sheets and price are known only after preparation; the form shows the browser's count as an estimate.

## The IPP gateway
`finalize` (`app/api/gateway/jobs/finalize/route.ts`) calls the same pipeline. It gets the same split: it records the intake, the print
server prepares, the gateway reports the job as "received" to the phone straight away (as now) and the print job appears after
preparation. The phone's job number must stay stable, so the gateway keeps its own id until the print job exists.

## Switch and rollout (so nothing breaks everyone)
- `PREPARE_VIA_SERVER` (per organization first, then global). Off = today's synchronous path, unchanged. On = the new path.
- Per-organization so the owner's school can run it alone for a week while others stay on the old path.
- Rollback = turn the switch off; prepare jobs already queued finish or expire.
- The old path is only deleted (P4) after a week on the real server with real prints compared against the old output.

## Tests that must exist before the switch is turned on
- Claim scoping: a server only ever gets its own organization's job; a revoked server gets nothing.
- Lease: expiry hands the job to another server of the same organization; renewal keeps it; a stale lease cannot complete.
- Signed URLs: the path cannot be chosen by the agent; a download URL only for the job's own source.
- The pipeline parity test: the same PDFs through the old synchronous path and through prepare produce byte-identical derived files
  (with `Date` frozen), including a Hebrew PDF, a Type 3 PDF, a booklet left and right, and a page-range job.
- End to end with a fake print server: upload, preparing, prepared, print job created, claimed, printed; also held, approval, quota
  rollback on failure, cancel while preparing.
- The independence drill from `docs/SAAS-LAUNCH-PLAN.md` with every print server off.

## Order of work
1. Migration file + route handlers + claim scoping tests (no behaviour change; nothing calls them yet).
2. Agent prepare worker with a fake website in tests (off by default, like `PRINTIO_LIBRARY_WORKER`).
3. Split `createPrintJob` into `intakePrintJob` and `finishPrintJob` behind `PREPARE_VIA_SERVER` (largest step; characterization tests first).
   - **3a DONE 2026-11-19:** the PDF steps are one function, `preparePdf` in `packages/pdf/src/prepare.ts` (no database), and `createPrintJob` calls it; all existing tests pass unchanged.
   - 3b: record the prepare job (choices, held reason, stamp text) instead of calling `preparePdf` inline, and add `finishPrintJob` (sheet limit, policy, quota, insert) for when the print server reports back. Plug `preparePdf` into the prepare worker as its pipeline.
4. Callers: `submitPrintJobAction`, `reprintJobAction`, `finishHeldBookletAction`, the gateway `finalize`.
5. UI: preparing card, offline message, hold reasons.
6. Parity test against real PDFs, then a week on the owner's server.

**Step 5 built 2026-11-19:** the print server's worker now runs `preparePdf` (`apps/agent/src/prepare-pipeline.ts`, loaded on the first job so an idle or switched-off server pays nothing; needs Node 22.13+, otherwise the worker stays off with a warning). Pickup: the worker looks every 10 s when idle and every 3 s for 2 minutes after each job. Still open: a "prepare job waiting" hint on the existing `jobs/claimable` poll for instant first pickup, and real timings on the owner's server.

## Decisions (owner, 2026-11-19)
1. **Expiry:** a prepare job that waits with no print server online expires after **24 hours** (built: `PREPARE_QUEUE_EXPIRY_MS`).
2. **Cancel while preparing: yes.** Because preparation is fast, the cancel window is short, so cancel must be race-safe: it marks the job
   `cancelled`; a print server that finishes anyway gets `409 cancelled` from `renew`, `original`, `upload-slot`, `complete` and discards its
   work (built and tested). The website will also delete any prepared file a cancelled job left behind (P2).
3. **Speed: a few seconds is fine, a few minutes is not acceptable at all.** This is a hard requirement, so:
   - **Target:** typical files (a few MB, under 50 pages) prepared in about 10 seconds including pickup.
   - **Limit:** if a file cannot be prepared within about 60 seconds the print server stops and fails the job with a plain reason
     ("This file is too large or complex to prepare quickly. Try a smaller or simpler PDF."), never a silent minutes-long wait. The limit is a
     setting, not a promise: **measure real prepare times on the owner's print server (real PDFs: a scan, a Word export, a 100-page file, a
     Hebrew booklet) before the switch is turned on**, and decide the numbers from that.
   - **Pickup must be quick without burning the free plan's request budget.** The print server must not poll a second endpoint every few
     seconds. Plan: the prepare claim rides on the existing once-per-cycle `jobs/claimable` call (the answer says "a prepare job is waiting"),
     and the print server polls **fast (about 3 s) for a couple of minutes after any activity and slowly (10-15 s) when idle**, so a school that is
     printing gets quick pickup while an idle server costs almost no requests. Until that is built the claim route can be called on the normal
     poll. Direct-to-Supabase (phase D) with Realtime would make pickup instant and request-free; it is the long-term fix.
   - Quick wins on the print server: skip the text-fidelity pass for small, non-Hebrew, non-booklet files only if the measurements show it is the slow
     part (it is a safeguard, so this needs the owner's yes); prepare at most one file at a time so printing is never starved.

