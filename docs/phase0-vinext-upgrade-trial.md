# Phase 0 raw notes: Next/React upgrade and vinext on the upgraded copy (2026-11-15)

Scratch copies only; nothing deployed, no accounts or keys. Summary: `docs/PHASE0-FINDINGS.md`. The upgrade as a patch: `docs/phase0-next-react-upgrade.patch` (`git apply` it; two files, versions Next 16.4.6, React/React-DOM 19.3.1, eslint-config-next 16.4.6, @types/react and @types/react-dom 19.3.0). Local CPU numbers are NOT Cloudflare CPU time.

# Phase 0, next step: framework upgrade (Part A) + vinext on the upgraded copy (Part B) - 2026-11-15

Scratch only (`.../scratchpad/vinext2/`): `copy` (upgraded), `base` (unupgraded, same commit a7065e9 = origin/claude/upcoming-large-project-3d2j9p),
`vcopy` (upgraded + vinext), `vstub` (PDF/font + icon stubs), `vicon` (real code, icon code removed). /home/user/printerio not modified by this work
(its working tree shows other changes made by another agent). Nothing committed, pushed, deployed; fake env values only.
Node 22.23.4, pnpm 10.33.0.

## Part A - the upgrade on its own
Chosen (npm, 2026-11-15): next **16.4.6** (`latest` tag, stable; >= 16.4.5 for OpenNext; published 2026-11-09), react + react-dom **19.3.1**
(`latest`, stable; vinext peer ^19.3.1; react-dom 19.3.1 peers react ^19.3.1), eslint-config-next **16.4.6** (same line as next), @types/react **19.3.0**,
@types/react-dom **19.3.0** (both `latest`; the 19.3 line). next 16.4.6 peer range accepts react ^19.0.0. No pnpm `overrides` exist in the repo. Only apps/web
has these deps (agent/gateway/shared do not use react/next). Canary/RC/preview tags (16.5.0-canary.*, 19.3.0-canary-*) were not used. React 19.2.9 (backport tag)
exists but vinext needs >= 19.3.1.
package.json (apps/web) diff: next ^16.4.2->^16.4.6; react/react-dom ^19.0.0->^19.3.1; @types/react ^19.0.2->^19.3.0; @types/react-dom ^19.0.2->^19.3.0;
eslint-config-next ^16.4.2->^16.4.6. Patch: `upgrade.patch` (2 files, 100+/100-; applies cleanly to a fresh `git archive` of the commit, and
`pnpm install --frozen-lockfile` passes after applying it).
Lockfile diff touches only: next, @next/env, @next/eslint-plugin-next, @next/swc-* (9 platform binaries), eslint-config-next, react, react-dom, scheduler (0.27->0.28),
@types/react, @types/react-dom, and the peer-suffix text of their dependents (lucide-react, styled-jsx, and cosmetic re-notation of eslint-plugin-import /
eslint-import-resolver-typescript / eslint-module-utils). No other package version changed. (Installed: +442 packages "added" only because node_modules was fresh.)

Check suite on the upgraded copy (all after `pnpm install` without --frozen-lockfile):
| command | result |
|---|---|
| pnpm -r typecheck | pass (shared, agent, gateway, web) |
| pnpm -r lint | pass, 0 errors; 1 warning (BookletPreview.tsx react-hooks/exhaustive-deps) - IDENTICAL on unupgraded base |
| web test | 203 files / 2232 tests pass (68 s) - the pdf "absurdly long label" test did not time out |
| agent test | 29 files / 470 tests pass (no Windows-only failures on Linux) |
| shared test | 10 files / 144 tests pass |
| gateway test (extra, part of `pnpm -r test`) | pass |
| web build (Next 16.4.6 / Turbopack) | success, 65 s; route list (76 lines) byte-identical to unupgraded build; same 3 pdfjs-dist "can't be external" warnings as base |
Zero failures, so nothing needed fixing and there is no source change in the patch.
Extra runtime smoke (`next start`, fake env, upgraded vs base): /, /privacy, /terms, /login, /manifest.webmanifest, /icon 200; /print -> 307 /login;
/admin/jobs -> 307 /go; /api/agents/jobs/claimable 401; /api/cron/sweep 401 with no/wrong bearer (500 "misconfigured" only if PRINTIO_CRON_SECRET unset or < the
required length - same as base); /pdfjs/wasm/jbig2.wasm 200. The "Sign-in required" error line in the server log appears in BOTH base and upgraded (pre-existing).
Not tested: anything logged in, real Supabase, server actions/uploads, PDF output byte-for-byte, browser rendering/hydration on React 19.3.1, Vercel's own
build environment, preview deploy. Risk: low-to-moderate. Minor-version bumps (16.4.2->16.4.6, 19.2.8->19.3.1) with a green suite and a clean, tiny lockfile diff;
but React 19.3 is a minor with new behaviour and the test suite has no browser/hydration tests. Mitigation: ship as its own PR and look at the Vercel preview
(login, print page upload, booklet preview) before merging; revert is the same patch in reverse.

## Part B - vinext
Installed (via `pnpm dlx vinext init`, as the vinext docs say): vinext **1.4.5**, @vinext/cloudflare 1.3.4, vite 8.3.0, @vitejs/plugin-react 6.3.0,
@vitejs/plugin-rsc 0.5.39, react-server-dom-webpack ^19.3.1, vite-css-modules 1.16.1, **@cloudflare/vite-plugin 2.0.0-beta.v.17 (beta)**, **cf 1.0.0-beta.32 (beta)**
(new Cloudflare CLI that replaces wrangler for vinext; pulls @cloudflare/config 0.32.1, workerd 1.20261113.1).
Docs followed: developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/ (the opennext page now says "Cloudflare recommends vinext") and
vinext.dev/docs/deploying/cloudflare + the package README. Cloudflare's page calls vinext "in beta"; the vinext README says "under active development ... not a drop-in replacement".
Command used: `pnpm dlx vinext init --platform=cloudflare --cdn-cache=none --data-cache=none --image-optimization=none --no-prerender` (13 s). (Earlier trial used
`--cdn-cache=static-assets`, which forces prerender of all routes and produced ~20 noisy "Sign-in required" prerender errors; `none` avoids that and is right for a dynamic app.)
What init changed: apps/web/package.json: + scripts dev:vinext, build:vinext (`vite build`), start:vinext (`vite preview`), deploy:vinext (`vinext-cloudflare deploy`);
+ deps vinext, @vinext/cloudflare, react-server-dom-webpack; + devDeps vite 8.3.0 (pinned exact), @vitejs/plugin-react, @vitejs/plugin-rsc, @cloudflare/vite-plugin (exact beta),
cf (exact beta), vite-css-modules; **adds `"type": "module"`** (the earlier trial also did; it makes eslint.config.js load as ESM - harmless here - and could affect any .js/.cjs
scripts); new files apps/web/vite.config.ts, apps/web/cloudflare.config.ts, apps/web/.gitignore (dist/, .vinext/, .cloudflare/). It no longer rewrites react versions (we already have 19.3.1)
and it keeps `next dev/build/start` working ("Next.js still works as before"): I verified `pnpm typecheck` passes and `next build` still succeeds in vcopy.
Gotcha found: `wrangler.jsonc`/open-next files no longer exist, so no deletion needed this time.
Env vars: declared in `cloudflare.config.ts` `env: { NAME: bindings.text("value") | bindings.secret() }` (docs only say "configure each binding in the Worker's env object";
the page does not spell out plain vars/secrets - found it in the @cloudflare/config typings: text() = plain var committed in config, secret() = value from .dev.vars / dashboard).
NEXT_PUBLIC_* are inlined at build from `.env.production.local`; I also declared them as text. Undeclared vars are invisible to the worker. `.dev.vars` is NOT in the repo's .gitignore
(must be added before anyone creates one). The build does not run `scripts/copy-pdfjs-assets.mjs` (public/pdfjs); `build:vinext` needs `node scripts/copy-pdfjs-assets.mjs` first (it was present in my copy from the earlier next build).
Also needed `compatibilityFlags: ["nodejs_compat"]` added by hand in cloudflare.config.ts (init does not add it; the app uses node:crypto/zlib/Buffer). Not tested whether it works without it.
`vite build`: success first time, 40 s, 905+718+993 modules, only SOURCEMAP_BROKEN warnings from vinext's own plugins. Output: `.cloudflare/output/v0/workers/default/{bundle,assets}`.

### Local run under workerd (`vite preview --port N`, same workerd used by cf dev)
Public: / /privacy /terms /login /manifest.webmanifest /icon /pwa/icon-192.png /sw.js -> 200. /pdfjs/wasm/jbig2.wasm (static asset) 200.
Logged out: /print /jobs /home -> 307 /login; /admin/jobs -> 307 /go. API: /api/cron/sweep, /api/cron/cleanup, /api/agents/jobs/claimable -> 401 (sweep 401 for a wrong bearer, 200 with the right fake secret).
/nope and /robots.txt 404. Startup log: no errors. Log noise: "[vinext] Server render error: Sign-in required" (same message Next prints), and
`failed to lookup address information` x28 = the sweep trying to reach the fake Supabase host (expected). The Cloudflare plugin printed a local-explorer banner; it has an observability
SQL endpoint (/cdn-cgi/local/explorer/api/local/observability/query) but it returns wall duration only, no CPU time.

### Gzipped size (same method as docs/phase0-cloudflare-build-trial.md: sum of `gzip -9` of every js/wasm/css/json in the worker bundle; script `measure.sh`)
| variant | this run (vinext 1.4.5, next 16.4.6, react 19.3.1) | earlier trial (vinext 1.4.5, next 16.4.2, react 19.3.1 via init) |
|---|---|---|
| real code as it is | **3.65 MiB** (js 2.93 + wasm 0.68 + css 0.03; raw 10.15 MiB; 523 js + 56 wasm) | 3.63 MiB |
| icon code removed only (app/icon.tsx, lib/pwa/icon-image.tsx, 5 app/pwa routes) | **2.75 MiB** (raw 7.79) - under the 3 MiB free limit by ~0.25 MiB | not measured |
| PDF libs + fonts stubbed (4a) | **1.95 MiB** (raw 5.70) | 1.93 MiB |
| 4a + icon code removed (4b) | **1.05 MiB** (raw 3.34) | 1.04 MiB |
Stubs: font base64 constants -> "", aliases pdf-lib -> named-export no-op proxy, @pdf-lib/fontkit and pdfjs-dist (all subpaths) -> default no-op proxy, via vite `resolve.alias` in vite.config.ts.
Takeaway: the real app minus only icon generation (no PDF work moved yet) is 2.75 MiB, i.e. icons -> static PNGs alone might get the CURRENT app under 3 MiB, with thin margin and real PDF code
still unable to meet 10 ms CPU. Still not verified: how Cloudflare counts a multi-module upload (I assumed sum of per-file gzip; `vinext-cloudflare deploy --dry-run` printed no size and the new `cf deploy --dry-run` needs auth, not tried).

### Cold start and per-request cost (LOCAL ONLY - not real Cloudflare)
Cold start (process spawn -> "Local:" printed ~2.1-2.4 s, mostly vite/workerd boot; first HTTP request to /privacy after that 0.73-1.0 s wall, three runs real code: 0.83/0.89/0.86 s;
a first run of an already-warm vite process measured 467 ms). Stubbed 4b: 0.73 s; icon-removed 0.85 s; so bundle size hardly moves the local cold start. Cloudflare's startup limit is 1 s
of script startup CPU - not measurable here.
Per-request, after 30 warm-up requests, 20 requests each, sequential via curl: wall avg incl. curl overhead and CPU = user+sys of the workerd process from /proc (includes
V8 + vinext + whole request, excludes curl/vite proxy). Real code, two runs:
| path | wall avg (ms) | workerd CPU per request (ms) |
|---|---|---|
| /login (SSR, logged out) | 21-25 | 11-13 |
| / (SSR, logged out; redirect/landing) | 20-26 | 12-15 |
| /privacy (SSR page) | 12-16 | 5-7 |
| /print (logged out -> 307; runs proxy/middleware) | 16-20 | 8-10 |
| /api/agents/jobs/claimable (401) | 11 | 4 |
| /api/cron/sweep (401) | 12 | 5 |
Run-to-run noise on this shared VM is about +/-30% (the icon-removed and stub runs read higher than the real one, which is noise, not signal). SO: local numbers suggest typical
simple pages are in the 5-15 ms range and the heavier logged-out pages (/login, /) are around or above the free plan's 10 ms CPU limit; API 401s are comfortably under. This machine's CPU is not
Cloudflare's; **real Cloudflare CPU time cannot be measured locally**, and none of this includes a real Supabase round trip (network wait does not count as CPU, but JSON parsing,
auth cookie verification, and any logged-in rendering would). Needs a real (free) Cloudflare account to settle.

### Fragile / undocumented
1. cf (1.0.0-beta.32) and @cloudflare/vite-plugin (2.0.0-beta) are betas, pinned exactly; vinext itself says "under active development".
2. `npx vinext check` run inside a project where vite 7 was hoisted (vitest brings vite 7) crashes ("vite does not provide an export named 'parse'"); `pnpm dlx vinext ...` works. pnpm also warns
   "unmet peer vite@^8.0.0" if vinext is added alone - init adds vite 8 itself.
3. Env var declaration: only discoverable through typings; plain values live in the committed config file; secrets need `bindings.secret()` + dashboard/`.dev.vars` (not in repo .gitignore). Wrong or missing declaration = pages 500 with the app's own env error (earlier trial).
4. `nodejs_compat` not added by init; had to add manually.
5. `"type": "module"` added to apps/web/package.json.
6. With build output present (`.cloudflare/`, `dist/`), `eslint .` lints generated files -> 15 errors; eslint config must ignore `.cloudflare/**`, `dist/**`, `.vinext/**`. (Clean CI checkout is unaffected.)
7. Workers Builds' default deploy command (`wrangler deploy`) cannot deploy a cloudflare.config.ts project: needs `pnpm run deploy:vinext` and an empty build command (docs).
8. `build:vinext` does not run the pdfjs asset copy script.
9. `runWorkerFirst: ["/*", ...]` means every request except /_next/static hits the Worker (counts toward 100k/day; public files like /pdfjs/* are served through the Worker via ASSETS binding).
10. cron: vinext-cloudflare has no cron story in the docs I read; Cron Triggers need a custom `scheduled` handler (not tried).
11. Not tried: `cf dev` (used `vite preview`), real deploy, cache adapters, server actions, anything logged in.

## Files
upgrade.patch, RESULTS.md, measure.sh, bench.sh, bench-*.log, vinext-init.log, vinext-build*.log, up-*.log (Part A command output).
