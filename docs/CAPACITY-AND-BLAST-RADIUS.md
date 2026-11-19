# Capacity limits and blast radius (2026-11-19)

Read-only analysis from code and docs. **Nothing here was load-tested.** [E] = estimated from code constants, [U] = unknown.
Per-organization print speed (one print server, about 2-3 small jobs a minute, the 20th of 20 simultaneous jobs waits about 6-10 minutes) is in the capacity analysis summarized in `docs/STATE-2026-11-19.md` and `docs/REQUEST-BUDGET.md`.

## A. How much can it cleanly hold
| Layer | Holds | First thing that breaks |
|---|---|---|
| Website on the owner's PC | [E] a handful of schools | PC sleep, reboot, power or internet loss takes everyone down; a bad update hits everyone |
| Cloudflare free plan | [E] about 5-6 schools (~100k requests/day; owner server at 3 s ~31,700/day, others at 10 s ~11,500) | Daily request cap; unproven 10 ms CPU and 3 MiB size limits (site is 3.6 MiB) |
| Supabase free | [E] 1 org | 500 MB, pauses when idle, no backups. Pro ($25/month) required before org 2 |
| Supabase Pro | [U] dozens plausible | Realtime message cap (heartbeats), whole-database cleanup scans as data grows |
| People per org | [U] no member cap in code | Website CPU building PDFs (prepare-on-print-server fixes it, off by default). Per person: 20 submits per window, 10 open jobs, 300 sheets per job |
| IPP gateway (one per school) | [E] see limits: 600 req/IP/min, 3,000/min total, 512 connections, 150 MB uploads in memory, 2 uploads per device | 150 MB in-memory upload budget (busy answers); `u-<code>.printio.app` has no wildcard DNS yet |
| One print server | [E] 8,600-31,700 requests/day by poll speed | Printer hardware; poll cost lands on the shared website |

## B. What takes down one org vs everyone
| Thing | Takes down | Likelihood | Cheapest guard |
|---|---|---|---|
| Website host off | ALL | High while a home PC | Real host; outside uptime ping (missing) |
| Cloudflare daily cap | ALL | Medium at 6+ schools | $5 plan before the 4th school; 10 s polls |
| Supabase outage/paused/full | ALL | Medium on free | Pro plus a tested restore (planned) |
| Bad migration | ALL | Medium (5 unapplied) | Branch dry run, apply one at a time, check after each |
| Supabase connection limits | ALL | [U] | Check pooler on Pro (missing) |
| Cron loops all orgs | ALL (slowdown) | Low | Already capped (500 per run, 45 s deadline) |
| One org floods uploads | org, then ALL | Medium | **Built (2026-11-19, on by default, untested live):** per-org daily JOB cap, 5,000 per UTC day. No bytes cap yet (see below) |
| One org's print server misbehaves | org, then shared website | Medium | **Built (2026-11-19, on by default, untested live):** 120 requests/minute per print server on claimable, heartbeat and commands; 429 plus Retry-After |
| One org floods Realtime | ALL | Low-medium | Unpublish heartbeat table, 60 s backstop (not done) |
| Gateway flood | that school only | Medium | Per-IP/global limits exist |
| Tunnel/DNS | one school | Medium | Wildcard DNS redesign planned |
| Shared secrets (`GATEWAY_SHARED_SECRET`, cron secret) | ALL | Medium | Per-org credentials (phase D, partly built) |
| RLS mistake (0054 not applied) | ALL (cross-school data) | Medium | Apply 0054; run `docs/TENANT-ISOLATION-TESTS.md` |

## Cheapest guards, ranked
1. Apply migration 0054 after a branch dry run (owner's go needed).
2. Supabase Pro plus one tested restore before org 2.
3. BUILT, not live-tested: per-org daily upload cap next to the per-user limit.
4. BUILT, not live-tested: per-server rate limit on poll and heartbeat routes (reuses `check_rate_limit`).
5. Move the website off the home PC or add an outside uptime ping and status message; $5 Cloudflare plan before school 4.
6. Poll 10 s for every non-owner school; unpublish the heartbeat table from Realtime.

## Guards built 2026-11-19 (on by default, NOT tested live, not committed yet)
**Guard 1: per-organization daily job cap.** In `checkSubmitLimits` (`apps/web/lib/jobs/create-print-job.ts`), which every submit path shares (web upload, print again, prepare intake, gateway finalize). Runs LAST among the submit checks, before any quota is reserved, so nothing needs rolling back.
- Default 5,000 jobs per organization per UTC day. Change with env `PRINTIO_ORG_DAILY_JOB_LIMIT` (whole number; `0` switches the guard off). No migration, so no per-org override yet.
- Atomic: one `check_rate_limit` row per org (`org_daily_jobs:<orgId>`, 86400 s window = UTC day), so two simultaneous submits cannot both slip through.
- Over the limit: "Your school has reached its daily print-upload limit. Try again tomorrow, or ask your admin." (code `rate_limited`) plus a `warn` log line "organization daily print-upload limit reached".
- Fails OPEN if the counter errors or throws (error log, job goes through). No special case for any org, super-admin test org included.
- Counts submit attempts (a job refused later for size or quota still used one). Refused attempts also count, so a flooded org stays blocked until midnight UTC.
- **Not built: a bytes cap (5 GB).** `check_rate_limit` only adds 1 per call, and summing `print_jobs.file_size_bytes` per submit is too heavy. Follow-up needs a migration: a small `org_daily_usage` counter table with an atomic add-bytes RPC (with explicit grants, never anon), or an `organization_settings` limit column.

**Guard 2: per print-server request limit.** `lib/agent-rate-limit.ts`, used by `agents/jobs/claimable` (which also carries the prepare hint and embedded commands), `agents/heartbeat` and `agents/commands`. After authentication, before any other work.
- 120 requests per minute per agent, one shared budget (`agent_poll:<agentId>`). Normal use is about 32 a minute at a 2 s poll; the old three-calls-per-cycle rollback mode is 90 at 2 s. Over: 429, `Retry-After` set to the seconds left in the minute, a `warn` log line.
- Fails OPEN on limiter error or throw.
- Agent (`apps/agent/src/cloud-client.ts`, `orchestrator.ts`, `health-monitor.ts`): a 429 is not retried in the request, does not count as an auth or cloud failure (no outer back-off, no warning spam, one info line), and the poll loop sleeps at least the `Retry-After` time (default 30 s if absent, max 300 s).
- Cost to know: each poll now makes one extra small database write (the counter row). At 2 s polls that is about 30 extra writes a minute per print server on the shared database. Watch it; raising the poll interval to 10 s for non-owner schools cuts it.
- Tests: `apps/web/lib/jobs/org-daily-limit.test.ts`, `apps/web/lib/agent-rate-limit.test.ts`, `apps/agent/test/rate-limit-429.test.ts`.
