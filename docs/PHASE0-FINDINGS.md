# Phase 0 findings (2026-11-15) - read with `docs/TARGET-ARCHITECTURE.md`

Two read-only jobs, nothing live touched: (1) a code inventory (`docs/phase0-code-inventory.md`), (2) a build of the real website for Cloudflare Workers in a scratch copy (`docs/phase0-cloudflare-build-trial.md`).

## Can the real website run on Cloudflare's free plan?
**Yes, after phase 1, and only with vinext.** Compressed worker size against the free 3 MiB limit (paid 10 MiB):

| | OpenNext | vinext |
|---|---|---|
| The website as it is today | 6.26 MiB (fails free) | 3.63 MiB (just fails free) |
| Without the PDF and font code (phase 1) | 3.99 MiB (fails free) | 1.93 MiB (fits) |
| Also without the icon-image library | 3.21 MiB (still ~7% over) | 1.04 MiB (fits) |
| An empty Next app, for scale | 0.86 MiB | |

Both adapters built the real app on the first try and ran it locally; public pages answered, logged-out pages redirected, cron and agent APIs returned 401. **Not tested:** anything logged in, real CPU per request (the free limit is 10 ms), Supabase calls, uploads, cron. Recommendation: **vinext** (about half the size, supports `proxy.ts`, Cloudflare recommends it for new Next apps). It is new; it needs React 19.3.1+ (app has 19.2.8) and Next/React bumps, so the switch includes a framework upgrade. OpenNext stays as a fallback and would need the paid plan (about $5 a month).

Biggest size contributors (uncompressed): pdfjs-dist 3.0 MB (bundled three times; `serverExternalPackages` is ignored on Workers), Next server code ~3 MB + 1.9 MB, Supabase libraries 1.6 MB (two copies of auth code), pdf-lib + fontkit + pako ~1.7 MB, base64 fonts ~1.1 MB; icon generation costs 0.6-0.9 MiB compressed.

## Blockers, easiest first
1. Environment variables must be declared for vinext (`cloudflare.config.ts`).
2. Icon generation (`app/icon.tsx`, `lib/pwa/icon-image.tsx`, 5 routes under `app/pwa/`): replace with static PNGs.
3. `serverExternalPackages` for pdfjs does nothing on Workers (goes away with phase 1).
4. Node APIs that build but are untested at runtime: `node:crypto` (`lib/agent-auth.ts`, `lib/gateway/http.ts`, `lib/cron-auth.ts`; the legacy scrypt secret check is tens of ms of CPU, far over 10 ms), `node:zlib` (`lib/pdf/inflate-guard.ts`), `Buffer` use in booklet/daily-study code, `node:dns`/`node:https` in the SSRF-safe fetcher (leaves with phase 1). No `fs` or `child_process` in app code.
5. `proxy.ts` (Node middleware; one Supabase `getUser()` per request with a login cookie): supported by vinext, experimental under OpenNext.
6. Cron: `vercel.json` crons need Workers cron triggers or, better, Supabase `pg_cron` (the two daily routes are mostly SQL). The free plan allows 50 outbound calls per request and the sweep may exceed it. Lease recovery needs a SQL home before agents stop calling the website.
7. `maxDuration = 60` on the print pages and cron routes means nothing on Workers (only CPU limits apply).
8. **Hardest:** PDF work inside request handlers (print/booklet/actions.ts, preview-action.ts, library/daily-actions.ts, the 100 MB upload limit) cannot fit 10 ms CPU or 128 MB memory regardless of bundle size. This is the real phase 1 job.

## What the inventory changed in the plan
- **Agent traffic is 3x worse than first written:** three calls per 3 s cycle = about 86,400 requests a day per server (86% of the free daily limit for one school). An admin can already slow the poll up to 300 s (about 864 a day), but the real fix is phase 2 (direct to Supabase with Realtime).
- **The agent holds no Supabase key;** it sends `agentId.secret` to the website, which uses the service-role key for it. 53 files reference that key. The gateway uses it for one thing (uploading print-dialog PDFs; disappears with phase 3) and also sends one shared secret that is the same for every school (`GATEWAY_SHARED_SECRET`): phase 2 must replace that too.
- 14 heavy entry points in the website: submit/reprint/finish-held booklet; booklet preview; booklet builder; font upload; daily study (day fetch, build, import); link import; library browsing; Sichos In English refresh; test print; gateway `finalize`.
- **Page counting and thumbnails already run in the browser:** no move needed.
- **Too coupled to move without a rewrite:** `createPrintJob` (`lib/jobs/create-print-job.ts`, 694 lines): heavy PDF steps sit between policy, quota and the database insert, and policy needs the page count the heavy step produces. It must be split into "prepare file" (server job) and "create job" (website); all three callers change. The agent protocol (about 950 lines of routes plus quota and lease logic) must first become SQL functions and row-level-security.

## Safe order for phase 1 (least risk, most bundle saved)
1. Library and daily-study fetching, and the Sichos In English refresh (output already goes to Supabase tables; no user file involved).
2. Daily booklet build.
3. Booklet builder and font inspection (after steps 2 and 3, fontkit and every font file leave the website).
4. Link import and test print (removes the SSRF fetcher).
5. Booklet preview.
Then split `createPrintJob`.

## Rules for every step (so Printio does not go down)
The live site on the owner's PC is not touched until cutover. Each step is built beside the current path, behind a switch, and the old path stays until the new one has worked for real. Database changes only add things. Changes go through PRs with green checks. Nothing about hostnames, tunnels, DNS or the PC without the owner's explicit yes.

## Next experiments
- Replace icon generation with static PNGs (small, independent, needed for the size limit).
- In a vinext copy: PDF work stubbed behind the print server, then a real login against a Supabase test project, measuring CPU per request with `wrangler dev` or a throwaway free Cloudflare account (needs the owner's Cloudflare account; no deploy to anything live).

## Not verified
Real CPU per request; Cloudflare's 1-second startup limit; whether Cloudflare sums vinext's per-file gzip the way it was measured here; anything logged in; prefetch request counts; whether any legacy scrypt agent secrets remain in the database. vinext version numbers are as installed in the trial.
