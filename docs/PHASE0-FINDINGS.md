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
2. Icon generation (`app/icon.tsx`, `lib/pwa/icon-image.tsx`, 5 routes under `app/pwa/`): replace with static PNGs. **Done (2026-11-15):** the 6 icons are now static PNGs in `apps/web/public/` (byte-identical to the generated ones, same URLs; `/icon` is a rewrite to `public/icon.png`); the generator code is gone and nothing imports `next/og`. `apps/web/lib/pwa/icons.test.ts` checks every icon URL and its PNG size.
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

## Next step results (2026-11-15, later): the framework upgrade and vinext on it
Raw notes: `docs/phase0-vinext-upgrade-trial.md`; the upgrade itself: `docs/phase0-next-react-upgrade.patch`.
- **Versions:** Next 16.4.6 and React/React-DOM 19.3.1 (newest stable; satisfy both vinext and OpenNext), eslint-config-next 16.4.6, @types/react and @types/react-dom 19.3.0. On a scratch copy every check passed with no source change: typecheck, lint (0 errors), web 2232, agent 470, shared 144 tests, web build with an identical route list; a local run behaved the same (public pages 200, logged-out pages redirect to login, agent and cron APIs 401). The lockfile change touches only next, @next/*, the SWC binaries, eslint-config-next, react, react-dom, scheduler and @types/react*.
- **Decision:** the upgrade is NOT shipped to the live branch now. It is only needed for the Cloudflare version, the tests have no browser or logged-in coverage, and the Vercel preview that would normally allow a click-through is blocked. It rides with the Cloudflare trial branch (apply the patch there); the live site stays on the proven versions until the cutover.
- **vinext 1.4.5 builds and runs locally** (workerd). Size with the real code as it is: 3.65 MiB; with only the icon code removed (now done in PR #120): **2.75 MiB (under the free 3 MiB, thin margin)**; PDF and font code stubbed: 1.95 MiB; both: 1.05 MiB. Cold start about 0.8 s locally.
- **CPU per request (local only, plus or minus 30%; NOT real Cloudflare time):** logged-out `/login` and `/` about 11-15 ms, `/privacy` 5-7 ms, API 401s 4-5 ms. Logged-out pages sit around the free 10 ms limit, so real measurement on a Cloudflare account is the experiment that can still decide between the free plan and the $5 plan.
- **Fragile or undocumented:** the `cf` CLI (1.0.0-beta.32) and `@cloudflare/vite-plugin` (2.0.0-beta) are betas; environment variables must be declared in `cloudflare.config.ts` (`bindings.text` for plain values, `bindings.secret` for secrets; not explained in the docs); `nodejs_compat` must be added by hand; `vinext init` adds `"type": "module"` to package.json and rewrites config; `.dev.vars` is not in `.gitignore`; ESLint must ignore the generated `.cloudflare/` and `dist/`; `vinext check` crashes if vite 7 is hoisted (use `pnpm dlx`); the pdfjs asset copy does not run in `build:vinext`; cron has no documented route. OpenNext remains the fallback (needs the paid plan).
- **Still not measured:** real Cloudflare CPU, how Cloudflare counts a multi-file upload, anything logged in, server actions, uploads, cron, `cf dev` (the trial used `vite preview`).
- **Next:** a Cloudflare account trial with a real Supabase test login (needs the owner's free Cloudflare login and a limited deploy token), on a trial branch carrying the upgrade patch. Then phase 1.
