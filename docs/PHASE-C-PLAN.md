# Phase C plan: heavy work becomes server jobs (written 2026-11-15, before any code)

Read with `docs/TARGET-ARCHITECTURE.md` (section 6, phase C) and `docs/PHASE0-FINDINGS.md` (the inventory). Rule for every step: the live site on the owner's PC keeps working exactly as it does today; each step is built beside the current path, **behind a switch that is OFF by default**, and the old path stays until the new one has worked for a week.

## Why start with the library
The library browser fetches a Mafteiach page and parses it (up to 3 MB of HTML) on the website on every browse, relying on a one-hour Next.js fetch cache that does not exist on Cloudflare. Daily study fetches and parses a day's page on first request. Both are too heavy for the 10 ms limit and rude to the sources once several schools use them. Their output already goes into Supabase tables (`library_daily_texts`, `library_sie_entries`) or is returned as JSON, and no school file is involved: the safest first move.

## The mechanism (C1)
1. **`library_pages`** (shared read-through cache): `key` (primary key, built from a fixed shape, e.g. `likkutei:12`, `list:maamorim:5710`, `entry:/maamorim/123`, `daily:2026-11-15:tanya`), `kind`, `payload` (parsed JSON, size-capped), `source_url`, `fetched_at`, `expires_at`, `fetched_by` (agent id). Everyone signed in may read it (public library data, like `library_daily_texts`); only the service role writes it.
2. **`server_jobs`**: `id`, `kind` (`library_fetch` first), `organization_id` (who asked), `requested_by`, `params` (a small structured object, never a URL), `dedupe_key` (one active job per key), `status` (queued / claimed / done / failed / expired), `claimed_by`, `lease_until`, `result_key`, `error`, timestamps. Members read their own school's jobs (to show progress); only the service role writes.
3. **Website** (a server action, unchanged signature for the screens): read `library_pages`; if fresh, return it. If missing or stale: with the switch OFF, do today's live fetch; with the switch ON, enqueue a job (deduped) and return "pending"; if no server that can fetch is online (heartbeat older than about 2 minutes), return "print server offline, try again when it is on".
4. **Agent** (only a server flagged as a library fetcher, the owner's, and only when `PRINTIO_LIBRARY_WORKER` is set): a separate small loop, never in the print loop. It claims a job, rebuilds the URL itself from `params` with the shared URL builder, fetches politely (at least 5 s between requests, 15 s timeout, 3 MB cap), parses with the shared parsers, and posts the parsed result to a website endpoint that validates it and writes `library_pages`. Interim: these two endpoints (`claim`, `complete`) live on the website; in phase D they become database functions.
5. **Parsers move** from `apps/web/lib/library/*` into `packages/shared` (pure TypeScript, with their tests and fixtures) so the agent and the website use the same code. This is a pure refactor and is the first PR (C1a).
6. **Week-ahead daily text** (C1d): the owner's server enqueues and fetches the next 7 days at a quiet hour; old days are pruned after about 60 days.

## Sub-steps (one PR each, one agent at a time)
- **C1a** move parsers and URL builders to `packages/shared`, no behaviour change. Gate: all tests green, the page works as before.
- **C1b** migration (tables, explicit grants, RLS), website read-through logic behind the switch, the two agent endpoints, the isolation-test matrix updated for the new tables (the test fails closed until their access is stated), tests.
- **C1c** the agent library worker, isolated, off by default, with tests.
- **C1d** waiting states in the UI, then the week-ahead schedule.
- **Switch on** only after the owner has pressed Update now on the PC and watched a fetch complete; roll back by switching off.

## How this could fail (and what stops it)
| Risk | Prevention |
|---|---|
| Breaking the library the owner uses today | Switch OFF by default; old live-fetch path kept; flip only after a real fetch worked |
| The agent update disturbs printing (the agent prints) | The worker is a separate async loop, wrapped in try/catch, concurrency 1, hard timeouts, only runs when its env flag is set; it cannot block the print loop; unit-tested for "fetch hangs", "parse throws", "server returns garbage" |
| A school server poisons the shared cache | Only agents flagged as library fetchers may complete jobs; schema validation (zod), key must match the allowed shapes, size cap, first writer wins until expiry, `fetched_by` recorded, owner can purge a key |
| SSRF (fetching an address the cloud chose) | Job params are structured; the agent builds the URL from the fixed allow-list (`libraryPageUrl`); a URL is never accepted from the cloud; redirects must stay on the source's origin |
| Job spam or stampede (20 people open the same page) | `check_rate_limit` per user; one active job per `dedupe_key`; global cap on queued jobs; queued jobs expire after 10 minutes |
| A job stuck because the agent died mid-claim | `lease_until`; the next claim reclaims an expired lease; the UI says "taking longer than usual" after a timeout instead of spinning |
| The source changes its page (parser sees nothing) | Job fails with reason `different`; negative result cached for 5 minutes only; the screen says so plainly (as it does today) |
| Browser polling eats Cloudflare requests later | Realtime subscription on the job row and the cache row, with a slow backstop poll (5 s, capped at 60 s total); never a tight loop |
| Database growth | Payloads capped; delete pages not read for 30 days; daily text pruned after about 60 days |
| Too much power on the website endpoints | They are agent-authenticated, owner-agent only, rate limited, validate everything, and write only the two cache tables |
| Migrations that cannot be rolled back | Additive only; new tables with explicit grants (never `anon`); mirrored in `schema.sql`; reversible by dropping the new tables |
| The owner's PC not updated | Switch stays off until Update now was pressed and a test fetch worked |

## Not in C1
The booklet builder, link import, test print and preview (later C steps), and splitting `createPrintJob` (last).

## Status
Not started. Open owner decisions: none for C1a. For C1b the switch name and where it lives (an environment variable on the PC, default off) are decided here; changing it needs a website restart.
