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
| One org floods uploads | org, then ALL | Medium | **No per-org storage/upload cap exists** (per person only) |
| One org's print server misbehaves | org, then shared website | Medium | **No per-server rate limit on poll/heartbeat** (poll interval is enforced, 2-300 s) |
| One org floods Realtime | ALL | Low-medium | Unpublish heartbeat table, 60 s backstop (not done) |
| Gateway flood | that school only | Medium | Per-IP/global limits exist |
| Tunnel/DNS | one school | Medium | Wildcard DNS redesign planned |
| Shared secrets (`GATEWAY_SHARED_SECRET`, cron secret) | ALL | Medium | Per-org credentials (phase D, partly built) |
| RLS mistake (0054 not applied) | ALL (cross-school data) | Medium | Apply 0054; run `docs/TENANT-ISOLATION-TESTS.md` |

## Cheapest guards, ranked
1. Apply migration 0054 after a branch dry run (owner's go needed).
2. Supabase Pro plus one tested restore before org 2.
3. Per-org daily upload/storage cap next to the per-user limit.
4. Per-server rate limit on poll and heartbeat routes (reuse `check_rate_limit`).
5. Move the website off the home PC or add an outside uptime ping and status message; $5 Cloudflare plan before school 4.
6. Poll 10 s for every non-owner school; unpublish the heartbeat table from Realtime.
