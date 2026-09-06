# Testing

Printio has two very different kinds of "tested": automated unit tests that run
in seconds against pure logic, and physical validation that a real job printed
correctly on a real machine. Neither substitutes for the other, and this
project's ethos — stated throughout [architecture.md](./architecture.md) and
[known-limitations.md](./known-limitations.md) — is to never claim more than
what's actually been verified. A green test suite means the *logic* is correct;
it does not mean a document has ever physically come out of the Kyocera
TASKalfa MZ8500i stapled in the right corner.

## 1. Automated tests

### Running them

```bash
pnpm -r test
```

runs every workspace package's suite (Vitest) in one shot, per the root
`package.json`'s `test` script. Individually: `pnpm --filter @printio/shared
test`, `pnpm --filter @printio/web test`, `pnpm --filter @printio/agent test`.
As of this writing all three pass clean (26 + 50 + 57 = 133 tests) — see the
root [README.md](../README.md) "Current status & next phase" for the
up-to-date count.

### What's covered

`packages/shared/src/*.test.ts` covers the three pieces of pure, I/O-free logic
shared by both apps:

- **`policy-engine.test.ts`** — the rules engine's precedence model
  (deny > require_approval > allow > org default, architecture.md sec 6.3),
  the "multiple reasons from the same tier are all collected, deduplicated,
  ordered by priority" behavior that produces the spec's multi-reason admin
  output, and the full condition operator set (`eq`/`neq`/`gt`/`gte`/`lt`/
  `lte`/`in`/`not_in`/`contains`/`between`). It mirrors the spec's own example
  policy (staff auto-allow envelope, six single-purpose require-approval
  rules, a student-always-approval rule, and a hard deny) directly in the test
  fixtures.
- **`print-math.test.ts`** — `computePrintMath` (printed sides = pages ×
  copies; physical sheets under simplex/duplex/booklet, including the
  "booklet is always 4-pages-per-sheet regardless of the duplex flag" rule
  and duplex's round-up-on-odd-page-count behavior), `computeBookletPadding`
  (padding a 6-page document to 8, architecture.md sec 8's worked example),
  and `computeCostCents` (optional per-org pricing, including paper-size
  multipliers and flat staple/booklet fees, returning `null` when no pricing
  is configured).
- **`job-state.test.ts`** — the state machine's allowed-transition table:
  that `approved → completed` is never legal (every intermediate step is
  mandatory), that a lease expiry correctly allows `claimed → approved`, that
  a bounded retry allows `failed → claimed`, that every state in
  `TERMINAL_STATES` really has zero outgoing transitions
  (`isDeadEnd`/`isTerminalState` agree), and that `failed` is retryable (not
  terminal) but still can't jump straight to `completed`.

These three modules are exactly the logic that must be provably correct
independent of any real database, browser, or printer — which is why they're
unit-tested in isolation rather than only exercised end-to-end.

`apps/web/lib/pdf/*.test.ts` covers server-side PDF handling in isolation
(via `pdf-lib`, no network/DB): `preflight.test.ts` — a well-formed PDF
returns the real page count regardless of what a caller might claim, a
missing `%PDF-` header is rejected without attempting a full parse, a
truncated/malformed body is rejected cleanly (no crash), and an oversized
file is rejected before/without being treated as valid; `booklet.test.ts` —
the 6→8-page padding worked example from architecture.md sec 8, a no-op on a
document already a multiple of 4, and confirmation that the original bytes
are never mutated. `lib/reports.test.ts` covers the admin Reports page's pure
aggregation helpers (by-user/department/printer grouping, color-usage split,
recently-denied/failed filtering, monthly usage summation) independent of any
database, exercising the "sheets only count for jobs that actually reached a
printer" rule directly. `lib/pdf/imposition.test.ts` covers real N-up
saddle-stitch booklet imposition (architecture.md sec 8): `bookletPageOrder`'s
signature formula against the textbook 4/8/12-page worked examples, that the
output page count is exactly half the padded input, and — the test that
actually proves the point of the feature — decoding the real PDF content-
stream transform matrices back out of a produced file to confirm two
differently-sized pages land at genuinely different, independently-computed
scales in the same output slot (not just "it didn't crash"). `lib/auth/
domains.test.ts` and `lib/auth/reauth.test.ts` cover the sign-in domain-
restriction parsing/validation and the 30-day forced-reauth expiry check
(architecture.md sec 19) as pure logic, independent of Supabase/Postgres — the
actual enforcement lives in `email_domain_allowed()` (SQL) and
`getCurrentSession()` respectively, which these tests don't reach (that's
covered by the manual RLS/auth checklist in §3, same as everything else that
needs a real database).

`apps/agent/test/*.test.ts` (57 tests) covers the Agent logic that *can* be
isolated from real Windows/hardware: `print-executor.test.ts` (the
SumatraPDF settings-string builder only emits the allow-listed token
vocabulary and never shell-interpolates), `spooler-monitor.test.ts` (job
status classification - `JOB_STATUS_PRINTED` vs the real error signals),
`commands.test.ts` (the fixed remote-command switch rejects anything outside
`REMOTE_COMMANDS`), `job-queue.test.ts` (local persistent queue, including
recovering from a corrupt state file instead of throwing), `cloud-client.test.ts`
(retry/backoff, normalizing raw fetch failures), and `secure-storage.test.ts`.

### What's NOT yet automated (and why)

- **RLS cross-org isolation as a scripted test.** There is no automated test
  suite today that spins up two organizations, two users, and asserts (via
  the Supabase client, under RLS) that org A cannot read org B's rows. This
  matters enormously — see the manual checklist in §3 — but as of this
  writing it is a manual procedure, not a CI-run script. Building one
  (e.g. a Vitest/Playwright suite against a local Supabase instance seeded
  with two orgs) is a reasonable next step, not yet done.
- **Agent integration tests against real Windows/hardware.** There is no
  automated test that runs `apps/agent` against a real (or even mocked)
  Windows Print Spooler, SumatraPDF process, or PowerShell PrintManagement
  module — the parts of the Agent that inherently require Windows and a real
  printer are covered only by the physical validation procedure below, and
  there is no realistic way to fully substitute for that with a mock. The
  logic that *doesn't* require real Windows (command parsing, argv
  construction, job-state handling) is unit-tested per above.
- **End-to-end web app tests (Playwright or similar).** Every `apps/web`
  route/Server Action is covered by real, passing `typecheck`/`build`/`lint`,
  and the PDF-handling logic is unit-tested, but there is no browser-driven
  test exercising a full user flow (sign in → upload → approve → see status
  update live) against a running instance. This requires a real Supabase
  project with Google OAuth configured (see docs/deployment.md), which is why
  it hasn't been built in this environment - a reasonable next step once a
  real deployment exists to point it at.

## 2. Mandatory physical validation procedure

**This is not optional before trusting the Agent on real jobs.** A green
`packages/shared` test suite proves the policy engine and print math are
arithmetically correct; it proves nothing about whether SumatraPDF invoked the
right driver settings, whether the Kyocera TASKalfa MZ8500i's finisher
actually stapled the output, or whether the Agent recovers gracefully from a
printer going offline mid-job. Per known-limitations.md, `completed` in the
job state machine means "the spooler job left the queue cleanly," **not**
"physically confirmed" — the only way to know a job actually printed
correctly is to look at the paper.

Run every one of the following against a real Windows machine (with the
Agent installed per [agent-install.md](./agent-install.md)) and the real
Kyocera TASKalfa MZ8500i (with queues configured per
[printer-setup.md](./printer-setup.md)). For each case, "pass" is defined as a
physical/observable outcome, not a status string in the dashboard:

| # | Case | Pass looks like |
|---|---|---|
| 1 | 1-page, black & white | One physical page comes out, correct content, correct orientation. |
| 2 | 10-page, black & white | All 10 pages come out, in order, none missing or duplicated. |
| 3 | Duplex | Pages come out printed on both sides, correctly paired front/back (not offset by one page). |
| 4 | Color | Color content actually prints in color (not degraded to grayscale by a wrong queue/driver setting). N/A against the real MZ8500i in this build — it's the monochrome model (printer-setup.md); exercise this case against a color-capable printer profile once one exists. |
| 5 | Multiple copies (e.g. 3 copies of a 5-page doc) | Exactly 3 complete, correctly-collated sets come out — not 15 uncollated pages. |
| 6 | 11×17 (ledger/tabloid) | Output is physically on 11×17 stock, not scaled down onto letter paper. |
| 7 | Mixed page sizes within one document | Each page prints at its own intended size (or, if the org's policy is "reject mixed sizes," confirm it's actually rejected at preflight rather than silently printed wrong). |
| 8 | Stapling | Staple is physically present, in the correct corner/edge, on the correct queue. |
| 9 | Booklet | Pages are correctly imposed (2-up, folded/saddle-stitched if a stitcher is installed), reading in the correct order when the booklet is opened — not just "some pages came out." Test both binding sides (architecture.md sec 8): a "left edge binding" profile should read correctly LTR, and a "right edge binding" profile should read correctly RTL when opened from the right, e.g. with a Hebrew document. |
| 10 | Large job — define "large" concretely for your environment, e.g. **200 pages** | Job completes without the Agent crashing, without the spooler silently dropping pages, and the full page count is physically present. Pick a page count that's actually large relative to your printer's duty cycle and typical job sizes, and record what number you tested so this table stays honest rather than vague. |
| 11 | Printer offline (powered off / network-disconnected before submission) | Job transitions to `failed` with a recorded `error_message` (architecture.md sec 17) — not stuck silently, not falsely reported as `completed`. |
| 12 | Paper tray empty mid-job | Same expectation: a real, visible failure/paused state is reflected honestly, not a false `completed`. |
| 13 | Job cancellation (cancel while queued/printing) | The physical printer actually stops producing pages for that job (`Remove-PrintJob`, architecture.md sec 11) — confirm no extra pages come out after cancellation is issued. |
| 14 | Agent restart mid-job | On restart, the Agent reconciles with the cloud's view of the job (architecture.md sec 17) rather than losing track of it or double-submitting it. |
| 15 | Internet disconnected (Agent loses connectivity to the cloud) | The Agent keeps running against its local on-disk queue, does not lose in-flight job state, and reconciles cleanly once connectivity returns (architecture.md sec 17) — it should not crash or require a manual restart just because the network dropped. |

Record the outcome of each case (pass/fail, plus what you actually observed)
somewhere durable — this table only has integrity if failures get written
down as failures rather than silently retried until they happen to pass once.

## 3. Manual RLS verification checklist

There is no scripted cross-org isolation test yet (§1), so run this by hand
whenever RLS policies change, and at minimum once after any fresh deployment
(see [deployment.md](./deployment.md) §6, which references this checklist):

1. Create two organizations (Org A, Org B) — either via the super-admin
   bootstrap path or two separate invitation flows (architecture.md sec 2.2).
2. Create one user in each org (User A in Org A, User B in Org B), each with
   at least one print job, one printer, and one uploaded file, so there's
   something real for a leaked policy to expose.
3. Sign in as User A. Confirm:
   - The jobs list shows **only** Org A's jobs — Org B's jobs never appear,
     not even as a stray row that then errors out.
   - The printers/`printer_profiles` list shows only Org A's printers.
   - Attempting to fetch Org B's uploaded file (e.g. by guessing/constructing
     a storage path using Org B's known job id) fails — a signed URL request
     for a path outside `private.user_org_ids()` should be denied by the
     Storage RLS policy (architecture.md sec 3.3), not silently succeed.
   - If you know Org B's Realtime topic string (`org-<B's id>:jobs`), attempt
     to subscribe to it as User A and confirm it's refused — Realtime channel
     authorization (architecture.md sec 3.4) should reject a subscribe
     attempt for an organization User A isn't an active member of, even
     though the topic string itself isn't secret.
4. Repeat symmetrically as User B against Org A's data.
5. If either direction shows **any** of Org B's (or Org A's) data to the
   wrong user — even a single row, even just an id without content — treat
   this as a severity-critical bug and do not proceed to any other testing
   until it's fixed. Cross-tenant data leakage is the one category of bug
   this architecture is built specifically to prevent (architecture.md
   sec 2–3), so a failure here means the core design promise isn't holding
   in practice, regardless of how well everything else works.
