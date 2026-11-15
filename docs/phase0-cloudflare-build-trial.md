# Phase 0 raw notes: building the real website for Cloudflare Workers (2026-11-15)

Done in a scratch copy only; nothing deployed, no accounts or keys. Summary: `docs/PHASE0-FINDINGS.md`. Sizes are gzip (1 MiB = 1,024 KiB); the free limit is 3 MB compressed, paid 10 MB.

# Printio on Cloudflare Workers (free plan) - trial results

Date: 2026-11-15. Scratch copy: `.../scratchpad/cf-trial/copy` (OpenNext), `.../copy-vinext` (vinext), `.../hello` (empty Next app, for a floor).
`/home/user/printerio` was not touched (git status clean). No deploy, no account, no real keys. Fake env values only
(`apps/web/.env.production.local`, `.dev.vars`). Node 22.23, pnpm 10.33, next 16.4.2, react 19.2.8.

Limits used: free plan = 3 MB gzip worker, 10 ms CPU/request, 128 MB memory, 100k req/day. Paid = 10 MB gzip.
"gzip" below = `gzip -9` of the bundle wrangler produces (`wrangler deploy --dry-run --outdir`), which matches wrangler's own
"Total Upload ... gzip" line. 1 MiB = 1024 KiB.

## 1. Baseline `pnpm --filter @printio/web build`
- SUCCESS, 46 s (Turbopack, Next 16.4.2). 59 pages generated. Only warnings: `pdfjs-dist can't be external` (x3, because
  `serverExternalPackages: ["pdfjs-dist"]` points at an ESM-only package; app/(dashboard)/print).
- Route list: 68 entries, nearly all dynamic (f). Static: /_not-found, /dev/preview, /icon, /manifest.webmanifest, /privacy, /terms.
  "Proxy (Middleware)" listed (proxy.ts).
- Next 16 no longer prints First Load JS sizes; from `.next/diagnostics/route-bundle-stats.json` (uncompressed, browser):
  largest /dev/preview 1.18 MB, /jobs/[id] 0.83 MB, /jobs 0.83 MB, /admin/approvals 0.81 MB, /login 0.76 MB, /print 0.60 MB,
  /print/booklet 0.57 MB; typical 0.56-0.76 MB.
- `.next` 185 MB, `.next/server` 57 MB (incl. source maps), `public/pdfjs` 1.9 MB (copied by scripts/copy-pdfjs-assets.mjs).

## 2. OpenNext (`@opennextjs/cloudflare` 1.20.17 + wrangler 4.162.0)
Setup (copy only): `pnpm add -D @opennextjs/cloudflare wrangler`; `apps/web/wrangler.jsonc` (main `.open-next/worker.js`, assets dir,
`nodejs_compat`), `apps/web/open-next.config.ts` (`defineCloudflareConfig()`). Adapter peer dep wants next `>=16.4.5` (repo has 16.4.2):
pnpm warns "unmet peer", build still worked.
- `opennextjs-cloudflare build`: SUCCESS first try, 61 s. Prints "WARN Node.js middleware support is experimental in cloudflare, and not
  officially maintained by OpenNext maintainers" (proxy.ts runs as a Node middleware; Cloudflare docs also say Node middleware is "not yet supported").
- It does NOT write one bundle: `.open-next/worker.js` is 2 KB, it imports `server-functions/default/apps/web/handler.mjs` (22.2 MB raw, 2.4 MB gz)
  and `middleware/handler.mjs` (2.5 MB raw, 510 KiB gz). Wrangler bundles them at deploy.
- `wrangler deploy --dry-run`: `Total Upload: 26470 KiB / gzip: 6406 KiB`. Final worker.js 25,529,750 B raw, **5,898,325 B gzip (5.62 MiB)**;
  plus wasm/font: resvg.wasm 1,378,357 B (528,515 gz), yoga.wasm 71,736 (28,572 gz), Geist font 125,956 (58,876 gz) => **6.26 MiB gz total**.
  .open-next total 68 MB on disk; static assets 6.4 MB (assets are not counted against the 3 MB; free plan asset limit is 20k files, fine).
- Local run (`wrangler dev`, workerd): worker starts; GET /privacy 200 (first request 744 ms cold), /login 200, / 200, /manifest 200, /icon (PNG) 200,
  /print -> 307 /login, /admin/jobs -> 307 /go, /api/cron/sweep 401 (cron secret check), /api/agents/jobs/claimable 401. Warm wall time 16-100 ms
  (wall, not CPU). The Node proxy.ts middleware ran fine in workerd in this smoke test. NOT tested: any request with a real Supabase session.
- Biggest contributors (OpenNext server function, esbuild metafile + source-map attribution of `.next/server`; raw KiB; duplicates counted):
  1. pdfjs-dist  3,045 (bundled 3 times: legacy pdf.worker.mjs 1,696; legacy pdf.mjs 738; build/pdf.mjs 612)  [serverExternalPackages is ignored on Workers]
  2. Next.js server runtime  ~2,990 (app-page-turbo.runtime 747; load-manifest 375; @vercel/og index.edge 537) + 1,860 more Next code inside app chunks
  3. @supabase/* 1,599 (auth-js GoTrueClient.ts 279+169 = two copies, phoenix/realtime 121+73+47+44, GoTrueAdminApi 40, webauthn 37)
  4. pdf-lib 778 + @pdf-lib/fontkit 638 (fontkit.es.js 557) + pako 254 + @pdf-lib/upng 48
  5. Embedded base64 fonts under lib/booklet/fonts: ezra-sil-regular 405, david-libre-bold 173, david-libre-regular 166, eb-garamond 143,
     source-serif-4 136, libre-baskerville 120 = ~1,143 raw (custom-font chunk alone 952)
  6. zod 418 (two copies of v3/types.js, 178+177)
  7. @vercel/og wasm: resvg 1,346 raw / 515 gz (+yoga, font) - only used by app/icon.tsx and lib/pwa/icon-image.tsx (5 /pwa/*.png routes)
  8. node-html-parser 216; lucide-react 105; iceberg-js 45 (supabase storage)
  9. Node-middleware bundle 2,455 raw / 510 gz (second copy of Next + supabase ssr, because proxy.ts runs separately)
- Floor: an EMPTY Next 16.4.2 app through the same adapter = worker.js 4.2 MB raw, **860 KiB gz**. Next itself is not the problem.

## 3. vinext (Cloudflare's Next-on-Vite; vinext 1.4.5, @vinext/cloudflare 1.3.4, vite 8.3.0) - separate copy
- `vinext check`: 96% compatible (24 supported, 0 partial, 1 issue: `__dirname` in lib/db-test/harness.ts, test-only). proxy.ts, next/og,
  next/font/google, serverActions bodySizeLimit, serverExternalPackages, headers() all reported supported.
- `vinext init --platform=cloudflare --cdn-cache=static-assets --data-cache=none --image-optimization=none` (must delete wrangler.jsonc/
  open-next.config.ts first; it needs all those flags non-interactively). It rewrote package.json: react/react-dom ^19.0 -> ^19.3.1 (vinext peer
  requirement), added "type": "module", new devDeps (vite, @cloudflare/vite-plugin beta, cf CLI beta, @vitejs/plugin-rsc...), a vite.config.ts and
  cloudflare.config.ts (replaces wrangler.jsonc). Total time to install + build attempt: ~5 min.
- `vite build`: SUCCESS first try, 28 s. Only noise: sourcemap warnings; "[vinext] Error prerendering route /admin ...: Sign-in required"
  for ~20 auth pages (speculative prerender falls back to dynamic; harmless but noisy). Set prerender off to silence (vite.config.ts `prerender: { routes: "*" }`).
- Output is many lazy-loaded modules (523 js + 56 wasm), 10.16 MiB raw, **3.63 MiB gz total** (js 2.92, wasm 0.68, css 0.03).
  Largest: resvg.wasm 515 gz, pdf.worker 373 gz, custom-font 323 gz, @vercel/og index.edge 218 gz, pdf 143+124 gz, es(pdf-lib) 157+170 gz, hb.wasm 150 gz.
- Local run (`vite preview` = workerd): /privacy, /login, / 200; /print 307 /login; /admin/jobs 307 /go; /api/cron/sweep 401; claimable 401; /icon 200.
  Gotcha: env vars are not read from .dev.vars; they must be declared in cloudflare.config.ts (`env: { X: bindings.text("...") }`), otherwise pages 500
  with the app's own "Missing environment variables" error. Secrets should use `bindings.secret`/wrangler secrets (not verified).
- Not tested: server actions with uploads, authenticated pages, cron, real Cloudflare.

## 4. Size what-if (PDF/font code replaced by stubs)
How: `lib/booklet/fonts/*.ts` base64 constants set to "" (same export names); aliases pdf-lib -> stubs/pdf-lib.mjs (named exports that are no-op proxies),
@pdf-lib/fontkit, pdfjs-dist (+ /legacy/build/pdf.mjs, pdf.worker.mjs, build/pdf.worker.min.mjs) -> stubs/default.mjs. OpenNext: `turbopack.resolveAlias`
in next.config.ts and removed `serverExternalPackages`. vinext: vite `resolve.alias`. (First attempt with a CJS Proxy stub failed the Next build:
"Cannot read properties of undefined (reading 'of')" = `PDFName.of(...)` at module load in lib/pdf/active-content.ts / sanitize.ts; named ESM exports fixed it.)
No sharp/canvas in the app. The only "image" dependency is @vercel/og (next/og) wasm, so 4b removes that too (icon routes return 404 in the variant).

| Variant | OpenNext gz (worker + wasm) | vinext gz (sum of files) |
|---|---|---|
| Real app today | 6,406 KiB = 6.26 MiB | 3.63 MiB |
| 4a: PDF libs + fonts stubbed | 4,090 KiB = 3.99 MiB (worker.js 17.1 MB raw / 3.54 MB gz) | 1.93 MiB |
| 4b: 4a + @vercel/og removed (icons as static files) | 3,292 KiB = 3.21 MiB (worker.js 16.3 MB raw) | 1.04 MiB (3.36 MiB raw) |
| Empty Next app (floor) | 860 KiB | n/a |

Remaining OpenNext 4b weight: Next runtime ~3.0 MB raw, supabase ~1.6 MB raw (2 copies of auth-js), zod 0.4 MB (2 copies), node middleware
bundle 2.4 MB raw (510 KiB gz), node-html-parser 0.2 MB. vinext tree-shakes and de-duplicates far better.

## 5. Blockers / risks (file paths), roughly easiest to hardest
1. Env var delivery (config, small): vinext needs vars declared in `cloudflare.config.ts`; OpenNext reads `.dev.vars` / dashboard vars. Build-time
   `NEXT_PUBLIC_*` need to be present at build in the Workers build environment.
2. @vercel/og wasm (small): `apps/web/app/icon.tsx`, `apps/web/lib/pwa/icon-image.tsx` (5 routes in `app/pwa/*/route.tsx`) cost ~0.6-0.9 MiB gz.
   Replace with pre-rendered static PNGs (public/).
3. `serverExternalPackages: ["pdfjs-dist"]` in `apps/web/next.config.ts` has no effect on Workers (no node_modules at runtime): pdfjs is bundled
   into the server 3x (3 MB raw). Server-side pdf.js use: `lib/pdf/content-analysis.ts`, `lib/pdf/text-fidelity.ts`, `lib/library/sie-refresh.ts`, `lib/pdf/render-page.ts`.
4. Node-only APIs (built fine under nodejs_compat, runtime behavior NOT verified): `node:crypto` in `lib/agent-auth.ts` (incl. legacy `scryptSync`,
   slow = tens of ms CPU, over the 10 ms free limit for any agent still on a legacy hash), `lib/gateway/http.ts`, `lib/cron-auth.ts`,
   `app/api/devices/airprint-profile/route.ts`, `app/(dashboard)/print/{import-link-action,preview-action}.ts`, `app/(dashboard)/print/booklet/actions.ts`,
   `lib/jobs/staged-upload.ts`; `node:zlib inflateSync` in `lib/pdf/inflate-guard.ts` (used by lib/pdf/preflight.ts, lib/booklet/assemble.ts);
   `Buffer` use in `lib/booklet/frontmatter.ts`, `lib/booklet/fonts/english.ts`, `lib/library/daily/fill.ts`. No fs/child_process in app code.
5. Node middleware: `apps/web/proxy.ts` (-> `lib/supabase/middleware.ts`). OpenNext: experimental, adds a 2.4 MB-raw second bundle. vinext: supported.
6. Cron: `apps/web/vercel.json` crons -> `/api/cron/sweep`, `/api/cron/cleanup` (maxDuration 60 s). Workers needs a Cron Trigger plus a `scheduled`
   handler (custom worker entry) or an external caller; free plan = 50 subrequests per invocation, the sweep makes many Supabase calls (not measured).
7. `maxDuration = 60` pages/routes: `app/(dashboard)/print/page.tsx`, `print/booklet/page.tsx`, `print/library/page.tsx`, `app/api/gateway/jobs/finalize/route.ts`,
   cron routes. Workers has no maxDuration; limit is CPU time (10 ms free; 30 s default paid, configurable to 5 min).
8. Heavy PDF work in request handlers (the real blocker for the 10 ms / 128 MB limits, not for size): pdf-lib/fontkit/pdf.js in server actions
   (`app/(dashboard)/print/booklet/actions.ts`, `preview-action.ts`, `library/daily-actions.ts`), 100 MB server-action body limit
   (`next.config.ts` experimental.serverActions.bodySizeLimit) vs 128 MB memory. Cannot fit free CPU; this is what phase 1 (print-server) must absorb.
9. pdfjs browser assets: `apps/web/scripts/copy-pdfjs-assets.mjs` only copies into `public/pdfjs` at build; worked unchanged for both adapters (served as static assets,
   1.9 MB). `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)` in client components worked at build.
10. Adapter version pins: OpenNext wants next >=16.4.5 (repo 16.4.2); vinext wants react >=19.3.1 (repo resolves 19.2.8). Upgrades are required for a supported setup.

## Unverified
- Real Cloudflare CPU time per request (only local workerd wall time); worker startup time limit (1 s) with the 25 MB bundle (cold first request 744 ms locally).
- Whether Cloudflare counts vinext's multi-module upload exactly as the sum of per-file gzip (assumed; wrangler dry-run for OpenNext matched gzip -9 of worker.js + wasm).
- Any authenticated flow, server actions, uploads, cron, Supabase connectivity (fake URL), caching/ISR, images.
- Stub measurements show size only; stubbed builds are not functional for PDF features.
