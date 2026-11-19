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
4. Callers: `submitPrintJobAction`, `reprintJobAction`, `finishHeldBookletAction`, the gateway `finalize`.
5. UI: preparing card, offline message, hold reasons.
6. Parity test against real PDFs, then a week on the owner's server.

## Open questions for the owner
- Expiry of a queued prepare job when no server is online: 24 hours?
- Should the sender be able to cancel while preparing? (Recommended: yes, it simply cancels the prepare job.)
- Is a few seconds to a minute of "Preparing..." acceptable for large files? (It replaces a request that today blocks for the same time.)
