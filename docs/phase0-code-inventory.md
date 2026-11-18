# Phase 0 raw notes: where heavy work, polling and the master key live (2026-11-15)

Read-only inventory made for phases 1 and 2 of `docs/TARGET-ARCHITECTURE.md`. File paths and line numbers are from the code at commit a7065e9; re-check before relying on a line number. Summary: `docs/PHASE0-FINDINGS.md`.

# Printio inventory for phases 1 and 2 (read-only, 2026-11-15)

All paths relative to /home/user/printerio. Line numbers verified by grep/read in this session. "Not verified" is stated where it applies.
Cloudflare limits assumed: 10 ms CPU/request, 100,000 dynamic requests/day, 3 MB compressed script.

## 0. Size evidence (why the website cannot stay as is)
Measured by gzip of the shipped files in node_modules / lib (a real bundler will differ somewhat, treat as order of magnitude):

| Piece | Gzipped |
|---|---|
| pdf-lib 1.17.1 (`dist/pdf-lib.min.js`) | 207 KB |
| @pdf-lib/fontkit 1.1.1 (`fontkit.umd.min.js`) | 342 KB |
| pdfjs-dist 6.3.289 legacy `pdf.mjs` + `pdf.worker.mjs` | 217 KB + 514 KB = 731 KB |
| Bundled fonts as base64 TS (`lib/booklet/fonts/**`, 9 files, 970 KB raw) | 452 KB |
| **Sum of heavy code** | **about 1.7 MB of the 3 MB** |

Also: `next.config.ts` sets `serverExternalPackages: ["pdfjs-dist"]` (apps/web/next.config.ts:36, comment "resolved from node_modules instead"), which means the server pdfjs is loaded from disk at request time. That cannot work on Workers at all.
`apps/web/package.json` dependencies that must disappear from the website: `pdf-lib`, `@pdf-lib/fontkit`, `pdfjs-dist` (server use only; the browser still needs pdfjs, see 1.J), `node-html-parser`.

---------------------------------------------------------------------------------------------------

## 1. HEAVY WORK IN THE WEBSITE (apps/web)

Common core: `lib/jobs/create-print-job.ts` (694 lines, `createPrintJob` L114) interleaves the PDF work with policy, quota and DB writes:
preflight L258 -> page subset L287 -> booklet pad+impose L342 -> stamp L389 -> text-fidelity check L407 -> print math -> policy L453 -> quota reserve L516 -> storage upload L570-572 -> `print_jobs` insert L595 -> events L682.
It is called from exactly three places: `app/(dashboard)/print/actions.ts` L46 (new upload) and L191 (finish held booklet), and `app/api/gateway/jobs/finalize/route.ts` L88 (print-dialog/IPP jobs).

### A. Print form (upload, preview, page counting, stamping)
| Entry point | What it does | Called by | Reads / writes | User waits? | Server-job shape |
|---|---|---|---|---|---|
| `submitPrintJobAction` `app/(dashboard)/print/actions.ts:52` -> `createPrintJob` | Whole pipeline above: sanitize (strip JS/attachments), page range, booklet imposition with margin crop (pdfjs content analysis), stamp, text check, then policy+quota+insert | "Print" button in `PrintForm.tsx` (L23, L37) | Input: file in multipart form (Server Action body limit 100 MB, `next.config.ts`) OR staged file downloaded from Supabase storage `print-jobs` (`form-pdf.ts:13`, `lib/jobs/staged-upload.ts:46`). Output: original + derived PDF uploaded to `print-jobs` (`create-print-job.ts:570-572`), `print_jobs` row, `print_job_events` | Yes, spinner until the job is created (page has `maxDuration = 60`, `print/page.tsx:16`) | `prepare_print_file` (preflight + sanitize + subset + impose + stamp + fidelity; returns pageCount, derived file, status). Website then does policy/quota/insert from the result. This is the coupling: policy and quota need `pageCount` from the heavy step |
| `reprintJobAction` `print/actions.ts:89` | Downloads the stored original with service role (L117-118), re-runs `createPrintJob` | "Print again" button (`jobs/[id]/ReprintButton.tsx`) | Reads storage, writes as above | Yes | same `prepare_print_file` |
| `finishHeldBookletAction` `print/actions.ts:161` | Same for a held booklet job being released (download L186-187, `createPrintJob` L191) | Held-job banner on job page | same | Yes | same |
| `previewBookletAction` `app/(dashboard)/print/preview-action.ts:40` -> `buildBookletPreviewPdf` (`lib/jobs/booklet-preview.ts:25`) | preflight, subset, impose, stamp the first page; no policy | "Preview booklet" button, and auto-preview when coming from builder (`PrintForm.tsx:462`, effect ~L476) | Uploads preview PDF to `print-jobs` (L115) and returns a signed URL (L120); browser then draws it with pdfjs (`BookletPreview.tsx`) | Yes | `preview` (returns PDF to the browser or a short-lived URL on the school server) |
| `sendTestPrintAction` `app/admin/printers/actions.ts:465` | Builds a test PDF with pdf-lib (`createTestPrintPdf` L511, `lib/pdf/test-print.ts`), preflight L525, uploads + inserts a print job (L552-602) | Admin -> Printers -> "Send test print" | storage upload + `print_jobs`/events | Yes | `test_print` (server builds the PDF itself; trivial) |
| Page counting + thumbnail | Already in the browser: `PDFDocument.load` via dynamic `import("pdf-lib")` (`PrintForm.tsx:340-341`) and `renderPdfPageToCanvas` (`lib/pdf/render-page.ts`, pdfjs) | File picker | None | No | **Nothing to move.** It is a client chunk, not part of the Worker script. Keep (note: only runs under the size threshold `shouldPreviewInBrowser`, `PrintForm.tsx:316`) |

### B. Booklet builder
| Entry | What | Called by | I/O | Waits? | Shape |
|---|---|---|---|---|---|
| `buildBookletAction` `app/(dashboard)/print/booklet/actions.ts:46` -> `assembleBooklet` (`lib/booklet/assemble.ts`, L97 in action) | Combines up to `MAX_SOURCES` PDFs: page ranges, cover, contents, back page, bidi/shaping (`lib/booklet/shaped.ts`, `bidi.ts`), embeds fonts with fontkit (`frontmatter.ts:3`) | `components/booklet/BookletBuilder.tsx` ("Build") | Input: files in the form (up to `MAX_TOTAL_BYTES`) + font choices; org custom fonts downloaded from bucket `org-fonts` (`lib/booklet/custom-font.ts:200`). Output: PDF to `print-jobs/gateway-intake/booklet-<user>/` (L117) + signed URL (L122) | Yes (`booklet/page.tsx:13` maxDuration 60) | `build_booklet` (input files: browser uploads to the school server first, per phase 3; output stays there) |
| Bundled fonts | `lib/booklet/fonts/david-libre-*.ts`, `ezra-sil-regular.ts` (statically imported by `frontmatter.ts:6-7` and `library/daily/fill.ts:2`), `fonts/english/*.ts` (lazy `import()` in `english.ts`) | the two builders | none | n/a | Move with the builders. The website only needs the font **names** (`ENGLISH_FONT_CHOICES`, imported by `booklet/page.tsx:10` and `daily-actions.ts:15`): split that list into its own tiny file |
| `uploadFontAction` `app/admin/fonts/actions.ts:19` -> `inspectFont` (`lib/booklet/custom-font.ts`, fontkit, L37) | Validates a font file an admin uploads (reads tables, checks Hebrew/Latin coverage) then stores it in `org-fonts` | Admin -> Fonts | writes bucket `org-fonts` + `org_fonts` row | Yes | `inspect_font` (or do the upload on the school server, phase 3 style) |

### C. Daily study
| Entry | What | Called by | I/O | Waits? | Shape |
|---|---|---|---|---|---|
| `dailyDayAction` `print/library/daily-actions.ts:162` -> `ensureDay` L133 | If no saved text for the date: fetch the day from `https://chitas-site.vercel.app` (`lib/library/daily/source.ts:13`, `source-fetch.ts`), parse HTML with node-html-parser, upsert 3-4 rows into `library_daily_texts` | `components/library/DailyStudyPanel.tsx` (date change, `load` L148) | Reads/writes table `library_daily_texts` (service role) | Yes (only on a cache miss) | `fetch_library_day` (owner's server, a week ahead, per plan) |
| `buildDailyBookletAction` L194 -> `buildFilledPdf` (`lib/library/daily/fill.ts`, 499 lines, L231) | Lays out the day's text into a booklet PDF with Hebrew shaping and fonts; returns the PDF **as base64 inside the server-action response** (`pdfBase64`) | DailyStudyPanel "Build" | Reads `library_daily_texts`, org fonts; no storage write | Yes | `build_daily_booklet` (school server; standard variants pre-built by owner server in phase 5) |
| `importDailyAction` L43 | Admin pastes saved .html pages; fetches Chabad.org feed (`feed-fetch.ts`), parses, upserts | Admin tab in DailyStudyPanel | table write | Yes | `fetch_library_day` variant (owner only) |

### D. Library (Mafteiach, SIE)
| Entry | What | Called by | I/O | Waits? | Shape |
|---|---|---|---|---|---|
| `libraryLikkutAction` / `libraryListAction` / `libraryEntryAction` `print/library/actions.ts:37/41/46` | Fetch third-party HTML (`lib/library/mafteiach-fetch.ts`, cached `next: {revalidate: 3600}` L54), parse with node-html-parser (`mafteiach-parse.ts`, 188 lines), return structured data; 10-min rate limit RPC (`check_rate_limit`) | `LibraryBrowser.tsx` (volume load `loadVolume` ~L167, clicks) | no Supabase data, only rate limit RPC | Yes, every browse click | `fetch_library_page` (read-through, result cached in Supabase table for everyone) |
| `refreshSieAction` L87 -> `refreshSie` (`lib/library/sie-refresh.ts`) | Fetches shop.sie.org weekly page, then **downloads each new PDF (up to 30 MB) and runs pdfjs** (`sie-refresh.ts:68`, `analyzeSiePdf`) to find first/last content page; upserts `library_sie_entries` | Library -> SIE tab "Check for new weeks" (admin only) | table `library_sie_entries` | Yes | `refresh_sie` (owner server on a schedule) |
| Library reads | `library/page.tsx:8` uses `sieFromRow` from `library_sie_entries`; `sie-weekly.ts` (23 KB static list) is shipped to the browser in `LibraryBrowser.tsx:11` | page load | table read | Yes | stays, it is a plain read |
| PDF fetch for a library item | `fetchPdf` (`lib/sources/fetch-pdf.ts`) via `libraryEntry`/LibraryBrowser -> `importLinkAction`; **uses `node:dns/promises` and `node:https` (L2-3)** for SSRF-safe pinned connections (`lib/sources/ssrf.ts`) | LibraryBrowser add-to-cart | outside fetch up to org max upload | Yes | `fetch_source_pdf` on the building server (plan: "fetched by whichever server builds the booklet") |

### E. Link import
| Entry | What | Called by | I/O | Waits? | Shape |
|---|---|---|---|---|---|
| `importLinkAction` `print/import-link-action.ts:29` | `normalizeSourceLink` (Drive/Dropbox/etc. link rewriting, `lib/sources/link.ts`), `fetchPdf` L52 with SSRF guard, writes file to `print-jobs` (L59), returns signed URL (L64); the browser then fetches the signed URL back (`LinkImport.tsx:61`, `BookletBuilder.tsx:114,166`) | `components/print/LinkImport.tsx` (L51), BookletBuilder | storage write + signed URL | Yes | `fetch_source_pdf` (server fetches, keeps file locally, browser pulls from school server) |

### F. Job file viewer
`app/(dashboard)/jobs/[id]/file/route.ts:22` GET: checks access, creates a 120 s signed URL (`FILE_URL_TTL_SECONDS` L9) with the service-role client (L40) and redirects. Cheap (no PDF code). Admin approvals: `createJobFileUrlAction` `app/admin/approvals/actions.ts:46` does the same, and the thumbnail is drawn in the browser (`ApprovalList.tsx:9,112`). **Light**, but depends on files being in Supabase storage: phase 3 changes it to "get a short-lived token for the school server".

### G. Print-dialog (IPP) intake
`POST /api/gateway/jobs/finalize` `app/api/gateway/jobs/finalize/route.ts:44` (`maxDuration = 60` L10): downloads the PDF (up to 50 MB) the gateway stored in `print-jobs/gateway-intake/<device>/` (L80), runs the **full createPrintJob pipeline** (L88), deletes the intake object. Same shape as A: `prepare_print_file`, claimed by the school server. The gateway already has the bytes in memory, so on a school server this becomes a local call.

### H. Other CPU-heavy-ish website code (not PDF)
| Item | Where | Note |
|---|---|---|
| `scryptSync` for old device secrets | `lib/agent-auth.ts:2,47` | Only for legacy `salt:hash` rows; new rows use `sha256:` (L19-21, upgraded on first use). scrypt in a 10 ms budget would fail, so confirm no legacy rows remain |
| Cron sweep/cleanup | see section 5 | loops over up to 500 rows per step |
| Proxy `getUser()` per request | `lib/supabase/middleware.ts:~60` | one network call to Supabase Auth per page request that has a cookie (wall time, little CPU) |

### I. Text-fidelity check (called out in the brief)
`lib/pdf/text-fidelity.ts` (132 lines) uses pdfjs server-side (`:45`), budget 4 s (`TEXT_CHECK_BUDGET_MS` L20), skips files over 8 MB (L22). Only called from `create-print-job.ts:407`. Also `lib/pdf/content-analysis.ts` (pdfjs, L113; budget 4 s, 8 MB cap) is called from `lib/pdf/imposition.ts:4,231` for the "fill" booklet fit. Shape: both are steps inside `prepare_print_file`; on the school server there is no need for the time budgets (but keep fail-open).

### J. Browser-side PDF code (fine, not in the Worker script)
`lib/pdf/render-page.ts:34`, `components/print/PagePicker.tsx:93-94`, `app/(dashboard)/print/BookletPreview.tsx:57-58`, `PrintForm.tsx:340`. These need static assets copied by `apps/web/scripts/copy-pdfjs-assets.mjs` into `public/pdfjs` (wasm 1.6 MB, standard fonts 0.8 MB, iccs 24 KB, `pdfjs-dist@6.3.289`): static files, no CPU. The `dev` and `build` scripts run that script first (`package.json` scripts). The script itself uses `node:fs/path/module` (build time only, fine).

### K. Count
**14 distinct heavy entry points** in the website: submit, reprint, finish-held, preview, build booklet, build daily, daily day fetch, daily import, link import, library browse (3 actions counted as 1), SIE refresh, test print, font upload, gateway finalize. Plus 3 pages hosting them with `maxDuration = 60` (`print/page.tsx:16`, `print/booklet/page.tsx:13`, `print/library/page.tsx:11`).
Non-test modules importing pdf-lib: `lib/pdf/{preflight,sanitize,active-content,booklet,imposition,page-subset,stamp,test-print}.ts` (+ `test-scan.ts`, test helper), `lib/booklet/{assemble,frontmatter,shaped}.ts`, `lib/library/daily/fill.ts`, `app/dev/preview/booklet.tsx` (dev only, 404 outside `next dev`: `app/dev/preview/page.tsx:1` `notFound`, guard test `preview-guard.test.ts`). fontkit: `lib/booklet/frontmatter.ts:3`, `lib/booklet/custom-font.ts:1`. pdfjs (server): `lib/pdf/content-analysis.ts:113`, `lib/pdf/text-fidelity.ts:45`, `lib/library/sie-refresh.ts:68`.

---------------------------------------------------------------------------------------------------

## 2. REQUEST-COUNT HOT SPOTS (browser)
Each `router.refresh()` = one dynamic page request to the website (plus the proxy's Supabase `getUser`). Realtime channels go straight to Supabase and do not count against Cloudflare.

| Where | Interval | Condition | Source | Suggestion |
|---|---|---|---|---|
| Job list `JobsList.tsx:136` | `ACTIVE_JOB_REFRESH_MS = 4,000` (`lib/ui/refresh-intervals.ts:9`) | Only while at least one listed job is "active"; paused when tab hidden | page `/jobs` | Realtime already subscribed (L99-125, channel `jobs-own-<user>`) and does a debounced 2 s `router.refresh`. Keep the poll only as a slow backstop: 30 s, or drop it once Realtime is proven |
| Job detail `JobStatusLive.tsx:169` | 4,000 | While job can still move (`stillMoving`); hidden tabs paused | `/jobs/[id]` | Same: Realtime channel `job-<id>` exists (L107-121). Slow backstop to 30 s |
| `ElapsedClock` `admin/agents/[agentId]/ElapsedClock.tsx:14` | 1,000 (local timer only, no request) | | | Fine |
| `JobStatusLive.tsx:183` | 30,000 local clock tick, no request | | | Fine |
| Home `components/home/AutoRefresh.tsx:17` | `HOME_REFRESH_MS = 30,000` | whenever tab visible, no activity condition | `/home` (`(dashboard)/home/page.tsx:96`) and `/admin` (`admin/page.tsx:194`) | Worst steady-state per open tab: 2,880 requests/day per tab left open all day (8 hours = 960). Replace with Realtime on `print_jobs` (already in publication) or raise to 120 s; stop when nothing changed |
| Print server page `admin/agents/[agentId]/CommandAutoRefresh.tsx` | 10,000 normally (`COMMAND_REFRESH_MS`), 5,000 during an update (`UPDATE_REFRESH_MS`) (`lib/ui/command-refresh.ts`) | only while a command or update is live; hard cap 120 refreshes | `admin/agents/[agentId]/page.tsx:150` | `remote_commands` and `agents` are already in the Realtime publication (`supabase/migrations/0011_realtime_publication.sql:14-16`): use Realtime and delete the poll. (TARGET-ARCHITECTURE says "every 2 s"; the code says 5 s / 10 s) |
| Approvals queue `admin/approvals/ApprovalQueue.tsx:61-72` | none, Realtime only (debounced 2 s refresh) | | | Good as is |
| Setup wizard `admin/printers/setup/SetupWizard.tsx:129,142` | `router.refresh()` on a button ("Recheck") only | manual | | Fine |
| `LibraryBrowser.tsx:118` | one `router.refresh()` after SIE refresh | manual | | Fine |
| `PwaBoot.tsx:22` | one `HEAD /sw.js` at boot | | | Serve `sw.js` as a static file, not a route (`app/sw.js/route.ts`) so it costs no Worker request |

Other: `revalidatePath` is called only inside actions (admin users, agents, etc.), on demand, not a loop. `export const dynamic = "force-dynamic"` only on `app/go/page.tsx:8` and `app/auth/confirm/page.tsx:7`. Next `<Link>` prefetch and RSC navigation requests also count as dynamic requests (not measured; check in phase 0). `SpotlightTour.tsx:180` polls an element with a timeout (local DOM only).
Estimate: a person with the job page open during a job: about 15 requests/min for the 4 s poll; Realtime makes them redundant.

The big one is not the browser, it is the agent: section 4.

---------------------------------------------------------------------------------------------------

## 3. SERVICE-ROLE KEY USE

### 3.1 Gateway (apps/gateway) - the one to remove in phase 2
- `apps/gateway/src/config.ts:7` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` required, `z.string().min(1)`), L33/62 (`supabaseServiceRoleKey`). `.env.example` L9-11 confirms the purpose.
- The **only** use: `apps/gateway/src/storage.ts:16-25` `createSupabaseStorage(url, key)`: uploads each print-dialog PDF to bucket `print-jobs` at `gateway-intake/<deviceId>/<uuid>.pdf` (`intakePath` L11). Wired in `src/index.ts:34`, used at `src/handlers.ts:360-362`. It never reads or deletes with the key.
- Everything else goes through the website with **one shared secret** `GATEWAY_SHARED_SECRET` (config.ts:6, min 32 chars) sent as `Authorization: Bearer` (`src/web-client.ts`); the website compares it in `lib/gateway/http.ts:34-49`. This secret is the same for every gateway and every organization, which also breaks the "a school sees only its school" rule: it needs replacing by a per-server credential in the same phase, not just the service-role key.
- What it would need instead: (a) once files stay on the school server (phase 3) the Supabase upload disappears entirely and the key has no use; (b) before that, a storage RLS policy on `print-jobs` for path prefix `gateway-intake/<its org>/`, or an RPC that mints a signed upload URL for one org; (c) a per-server JWT with `org_id` + `agent_id` claims (TARGET-ARCHITECTURE sec 5).

### 3.2 Agent (apps/agent)
No Supabase key at all (`grep` found no `SERVICE_ROLE`/supabase client in `apps/agent/src`). It authenticates to the website with `Authorization: Bearer <agentId>.<deviceSecret>` (docs/agent-api.md "Authentication"); the website then uses the service-role key on the agent's behalf in every `/api/agents/*` route. So the key is already off the PC for the agent, but the website holds it for every agent call. Moving to direct Supabase means re-implementing that auth as JWT claims + RLS (section 4).

### 3.3 Website (apps/web). `lib/supabase/service-role.ts` is the single factory; `lib/env.ts` reads `SUPABASE_SERVICE_ROLE_KEY`.
Stays on the website with the key (or becomes an owner-only Supabase edge function) vs could be per-server:

| Place (file:lines) | Purpose | Could a per-server credential do it? |
|---|---|---|
| `app/api/agents/*` (9 routes, each calls `createServiceRoleClient` for auth + queries) | Verify agent secret, claim/lease jobs, status, release, commands, heartbeat, download-url | **Yes, mostly**: RLS on `print_jobs` (select where `printer_profiles.agent_id` = JWT `agent_id`), RPCs `claim_job`, `report_job_status`, `release_job`, `agent_heartbeat`, `ack_command`; Realtime on `print_jobs`/`remote_commands`. download-url needs a storage signature, gone in phase 3. `register` (one-time enrol with code, rate limit `check_rate_limit` L38) must stay a website/edge endpoint (it mints credentials) |
| `app/api/gateway/*` (4 routes) | resolve device token hash, record events, finalize, job status, cancel | **Yes**: RPC `resolve_device(token_hash)` limited to the server's org, insert policy on gateway events, `print_jobs` select, `cancel_job` RPC; finalize becomes a local call |
| `lib/agent-auth.ts` | hash/verify device secrets, find agent | Replaced by JWT; enrolment/rotation stays owner-side |
| `app/api/cron/{sweep,cleanup}` | retention, lease recovery, expiry across **all orgs** | Cross-org by design: stays with the owner only (Supabase `pg_cron`/edge function) |
| `lib/lease-recovery.ts` (also run opportunistically by `jobs/claimable/route.ts:51`) | Return expired leases, fail stuck jobs, release quota | Needs to move into SQL (function + pg_cron) before agents stop calling the website, otherwise nothing runs it per agent |
| `app/(dashboard)/print/actions.ts` (4 uses), `preview-action.ts` (3), `booklet/actions.ts`, `import-link-action.ts`, `stage-upload-action.ts`, `form-pdf.ts`, `jobs/[id]/file/route.ts`, `admin/approvals/actions.ts` (6) | Write `print_jobs`/events/storage on behalf of a signed-in user (the user's own RLS client cannot insert the derived file, quota rows etc.) and sign file URLs | These are the **website acting for a user**, not servers. Keep with the key on the website (small code), or later switch to RPCs. They are the reason the key stays on Cloudflare as a secret |
| `print/library/actions.ts` (3), `daily-actions.ts` (5) | `check_rate_limit` RPC + writes to `library_daily_texts` / `library_sie_entries` (shared, org-less tables) | Writes move to the owner's server (only the owner's server writes shared text, TARGET-ARCHITECTURE sec 5): **owner only**. Reads can be plain RLS |
| `admin/fonts/actions.ts` (3) | `org_fonts` + bucket `org-fonts` | Per-org RLS could do it, or the school server holds the fonts |
| `admin/users/*` (page 3, actions 4), `lib/auth/{domain-join,bootstrap,invite-lookup,invitations,finish-sign-in}.ts`, `app/auth/verify-code/route.ts`, `admin/devices/actions.ts`, `(dashboard)/devices/actions.ts`, `lib/jobs/lifecycle.ts` callers (`jobs/[id]/actions.ts`, 4) | Sign-in, join by domain, invitations, member management, cancel queue, device delete | **Must stay with the website/owner** (identity). Not a server concern |
| `app/platform/**` (super-admin console: `actions.ts`, `page.tsx`, `super-admins/*`, `organizations/new/actions.ts`) | Cross-org reads, create org, promote/demote super admin (RLS blocks these for everyone else) | **Owner only** |
| `tools/self-host/setup-web.ps1:39,47` | Writes the key into the PC's `.env.production.local` | goes away with phase 6 |
| `.github/workflows/ci.yml:66` | placeholder `ci-placeholder-service-role-key` | not a real key |

Total: 53 non-test files reference the key (grep over apps, tools, .github; includes .env.example files and ci.yml).

---------------------------------------------------------------------------------------------------

## 4. AGENT/GATEWAY TO CLOUD CALLS

### 4.1 Agent (`apps/agent/src/cloud-client.ts`, loop `orchestrator.ts:861-920`)
One cycle (`runOnce` L847-861) runs **three** calls in a row: heartbeat, `GET commands`, `GET jobs/claimable`. Default sleep between cycles `DEFAULT_POLL_INTERVAL_SECONDS = 3` (`config.ts:47`), minimum 2 s (L46). An admin can set a different speed on the website (`agents.poll_interval_seconds`, migration 0049) up to 300 s (`MAX_ADMIN_POLL_INTERVAL_SECONDS` L49); it comes back in the heartbeat response. Failure backs off up to `maxPollIntervalSeconds`; revoked credentials slow to about 10 minutes.
**Arithmetic: 3 requests / 3 s = about 86,400 requests/day per server running 24/7**, i.e. about 86% of the whole free daily budget per school (TARGET-ARCHITECTURE sec 4 counts 28,800, which is one call per cycle; the code makes three). At the 300 s ceiling it would be about 864/day.

| Endpoint | When | Payload (order of magnitude) | Replace with |
|---|---|---|---|
| `POST /api/agents/heartbeat` (206 lines) | every cycle (3 s) | Request ~0.5-2 KB (version, queue list, machine info, raw printer probe reports). Response ~0.5 KB (`ok`, `serverTime`, `paused`, `pollIntervalSeconds`, `rawPrinters` targets). Does ~4 DB statements (agent update, profile read, printer updates) | (a) RPC `agent_heartbeat(payload)` called direct at a slow cadence (30-60 s); presence from `last_seen_at`; the pause flag and poll speed arrive via (b) Realtime on `agents` (already published) |
| `GET /api/agents/commands` | every cycle | Response ~0.1-1 KB, almost always `{"commands":[]}` | (b) Realtime on `remote_commands` (already published) + one fetch at start-up |
| `POST /api/agents/commands/:id/ack` | per command | ~0.5-5 KB (log bundles possible) | (a) RPC |
| `GET /api/agents/jobs/claimable` (63 lines) | every cycle | Response `{"jobs":[]}` ~12 B, up to 50 jobs x ~100 B = 5 KB. Also runs `recoverExpiredLeasesForAgent` (L51, throttled to one run per 5 min per `OPPORTUNISTIC_MIN_INTERVAL_MS`, `lease-recovery.ts:194`) | (b) Realtime on `print_jobs` filtered by the agent's printers + one catch-up query at start/reconnect |
| `POST /api/agents/jobs/:id/claim` (80 lines) | per job | tiny | (a) RPC `claim_job` (atomic, sets lease from `organization_settings.job_lease_minutes`) |
| `GET /api/agents/jobs/:id/download-url` (143 lines) | per job | ~1 KB JSON with signed URL + print request | (a) RPC for the print request; the file itself comes from the school server's own disk after phase 3 (today: Supabase storage signed URL, `createSignedUrl` L54) |
| `POST /api/agents/jobs/:id/status` (145 lines) | 4-6 per job | ~0.3 KB; also adjusts quota (`adjustMonthlyUsage` L114) | (a) RPC `report_job_status` (DB trigger already validates transitions, migration 0023) |
| `POST /api/agents/jobs/:id/release` (103 lines) | when printer unreachable | ~0.3 KB | (a) RPC, move backoff (30 s, 1, 2, 5 min) and the 2-hour give-up window into SQL |
| `POST /api/agents/register` | once | ~0.2 KB | (c) **stays a website/edge endpoint** (mints the credential; rate limit by IP) |
| Agent self-update | `CHECK_FOR_UPDATE` command runs `git fetch/pull` on the PC (`self-update.ts:629-634,523`) | n/a | Phase 4 (signed bundles), not phase 1-2 |

### 4.2 Gateway (`apps/gateway/src/web-client.ts`, handlers `handlers.ts`)
Not a timer loop; request-driven by phones/PCs. Caches: device resolve 60 s (`DEFAULT_CACHE_TTL`), negative 30 s, job status 3 s (`status-cache.ts:8`).
| Endpoint | When | Payload | Replace with |
|---|---|---|---|
| `POST /api/gateway/device/resolve` | on each IPP request with an uncached token (about once per minute per active device) | ~0.1 KB in, ~0.3 KB out | (a) RPC, org-scoped |
| `POST /api/gateway/events` | on each Get-Printer-Attributes / job received / rejected (`handlers.ts:268,353,387,485`) | ~0.2-1 KB | (a) plain insert (RLS) |
| `POST /api/gateway/jobs/finalize` | per print | request ~0.5 KB (the PDF goes to Supabase storage, up to 50 MB, with the service-role key); website downloads that file and runs the pipeline (60 s) | (c)->job: becomes a `prepare_print_file` job on the school server; the website only creates the row |
| `GET /api/gateway/jobs/:id` | status polls from the client, 3 s cache | ~0.3 KB | (b) Realtime or (a) select |
| `POST /api/gateway/jobs/:id/cancel` | per cancel | tiny | (a) RPC |
| (also `POST /api/devices/airprint-profile`, `app/api/devices/airprint-profile/route.ts:17`) | user downloads iOS profile | small | stays a website endpoint (browser-facing, uses `randomUUID`) |

### 4.3 What must stay a website endpoint (c)
Agent `register` and credential rotation, `auth/*` (login, magic link, verify-code), `api/admin/commands` (browser to issue a command; could also become an RPC called by the browser), device profile download, `sw.js`/manifest, and any minting of upload tokens and tunnel creation (phase 3-4).

---------------------------------------------------------------------------------------------------

## 5. CRON AND SCHEDULED
| Job | Defined at | Schedule | What it does | Needs Node? | Moves to |
|---|---|---|---|---|---|
| `GET /api/cron/sweep` (`app/api/cron/sweep/route.ts`, `maxDuration=60` L32, deadline 45 s L35) | `apps/web/vercel.json` `0 8 * * *`; PC: scheduled task "Printio cron sweep" daily 08:00 (`tools/self-host/setup-web.ps1:81` -> `tools/self-host/run-cron.ps1 -Job sweep`, plain `Invoke-WebRequest` with `PRINTIO_CRON_SECRET`) | daily (the route's comments still say "15-minute sweep") | (1) expire `pending_approval`/`held` past deadline + release quota (L62-135); (2-3) lease recovery via `lib/lease-recovery.ts`, fail stale mid-flight jobs; (3b) abandon failed jobs after 7 days; (4) retention: delete stored PDFs of finished jobs past org windows (`lib/retention.ts`, uses storage `remove`) | No Node-only API apart from `timingSafeEqual` in `lib/cron-auth.ts`. It is SQL-shaped except the storage deletes | Supabase `pg_cron` (steps 1-3b as SQL functions) + storage purge by edge function, or gone from storage once phase 3 lands. Cloudflare Cron Trigger could call a Worker route but then it is a counted request with 10 ms CPU, so SQL is better |
| `GET /api/cron/cleanup` (`app/api/cron/cleanup/route.ts`, `maxDuration=60` L10) | `vercel.json` `0 3 * * *`; PC task "Printio cron cleanup" 03:00 | daily | retention backstop, orphan storage objects (gateway-intake over 24 h, job files without a row: `lib/cleanup.ts:67`), prune finished `remote_commands` (30 days) and `rate_limit_buckets` older than a day (`prune_rate_limit_buckets` RPC exists, migration 0048:27) | No | Same: `pg_cron` for the two prunes; orphan sweep disappears with Supabase storage |
| Supabase keep-alive | not built | plan: tiny daily request | trivial | No | A single `pg_cron`-free option: Cloudflare Cron Trigger calling Supabase REST |
| Library fetches / SIE refresh | manual buttons now | plan: week ahead | see 1.C/1.D | Yes (pdfjs for SIE, node-html-parser) | owner's server |
No `pg_cron` or `cron.schedule` exists in `supabase/migrations` today (grep). Realtime publication exists for `print_jobs`, `agents`, `remote_commands` (migration 0011).

---------------------------------------------------------------------------------------------------

## 6. WORKERS BLOCKERS IN THE WEBSITE
| Item | Finding |
|---|---|
| Middleware | `apps/web/proxy.ts` (Next 16.4.2; the `proxy` convention). Next docs in `node_modules/next/dist/docs/.../proxy.md:253-255`: "Proxy defaults to the Node.js runtime ... `runtime` config is not available in Proxy files." So it is Node, not edge, and cannot be switched. It calls `updateSession` (`lib/supabase/middleware.ts`) which runs `supabase.auth.getUser()` (a Supabase network call) on every request with an auth cookie, skipping `api/agents/`, `api/gateway/`, static files and `/pdfjs/` via the matcher. Test: `proxy.test.ts` |
| Node-only imports, non-test code | `node:crypto` (`randomUUID`, `createHash`, `timingSafeEqual`, `randomBytes`, `scryptSync`): `lib/agent-auth.ts:2`, `lib/gateway/http.ts:2`, `lib/cron-auth.ts:2`, `lib/jobs/staged-upload.ts:2`, `print/import-link-action.ts:3`, `print/booklet/actions.ts:3`, `print/preview-action.ts:3`, `api/devices/airprint-profile/route.ts:1`. `node:zlib` `inflateSync`: `lib/pdf/inflate-guard.ts:1` (used on upload, inside preflight). `node:dns/promises` + `node:https` `request`: `lib/sources/fetch-pdf.ts:2-3` (SSRF-safe pinned fetch: this has no Workers equivalent as written). `Buffer` is used widely (`lib/booklet/fonts/english.ts` etc.). **No** `fs`, `path`, `child_process`, `os` or `net` in non-test app code. `fs`/`path` appear only in `lib/db-test/harness.ts:3-4` (test helper, not imported by app code: grep found no importers outside the folder), in `test/**`, and in build script `scripts/copy-pdfjs-assets.mjs` (build time). Most `node:crypto` uses work under Workers' Node compatibility flag; zlib/dns/https are the real ones, and all three live in code that moves out |
| pdfjs from `node_modules` at runtime | `next.config.ts` `serverExternalPackages: ["pdfjs-dist"]` + dynamic `import("pdfjs-dist/legacy/build/pdf.mjs")` at `content-analysis.ts:113-115`, `text-fidelity.ts:45-47`, `sie-refresh.ts:68`. Not possible on Workers; disappears when those files move |
| pdfjs asset copy | `scripts/copy-pdfjs-assets.mjs` runs before `dev` and `build` and fills `public/pdfjs` (gitignored). Needed only for the browser viewer; keep, as static assets. Matcher already excludes `pdfjs/` from the proxy (`proxy.ts` matcher) |
| Long execution | `maxDuration = 60` on 3 pages (`print/page.tsx:16`, `print/booklet/page.tsx:13`, `print/library/page.tsx:11`) and 3 routes (`api/gateway/jobs/finalize/route.ts:10`, `api/cron/sweep/route.ts:32`, `api/cron/cleanup/route.ts:10`). Nothing else sets `maxDuration`. All six are heavy-work or sweeping features discussed above |
| Streaming | No `ReadableStream`, `text/event-stream` or `TransformStream` in `app/`, `lib/`, `proxy.ts`. One 100 MB Server Action body limit (`next.config.ts` `serverActions.bodySizeLimit: "100mb"`): whole PDFs travel through the website today; large Workers request bodies and memory are a risk (limits not verified) |
| Responses carrying a PDF | `buildDailyBookletAction` returns the whole PDF base64 in the action response (`daily-actions.ts:259`, `pdfBase64`); other builders go through storage + signed URL |
| Build-time env | `next.config.ts` bakes `VERCEL_GIT_COMMIT_SHA`/`GITHUB_SHA` and build time into `env` (L11-20); fine, but `lib/build-info.ts:44-46` reads `VERCEL_*` at runtime too (cosmetic) |
| Fetch cache options | `next: { revalidate }` in `lib/library/mafteiach-fetch.ts:54`, `daily/feed-fetch.ts:14` rely on the Next data cache (behaviour on Cloudflare differs; moves out anyway) |

---------------------------------------------------------------------------------------------------

## 7. SAFE ORDER (suggestion)
Criteria: least coupling, most bundle saved, clear "server offline" fallback.

1. **Library and daily-study fetching** (D + C fetch half: `libraryLikkut/List/Entry`, `refreshSieAction`, `dailyDayAction`/`ensureDay`, `importDailyAction`). No PDF code except SIE (pdfjs), no user file involved, output is a Supabase table that already exists (`library_daily_texts`, `library_sie_entries`). Removes `node-html-parser`, server pdfjs for SIE, outside fetching. Shape: `fetch_library_day`, `fetch_library_page`, `refresh_sie`. Low risk: today's pages keep reading the tables.
2. **Daily-study booklet build** (`buildDailyBookletAction` -> `buildFilledPdf`). Self-contained (text in, PDF out), the output currently comes back in the response, so a job result is a drop-in. Saves `fill.ts` plus the Ezra SIL font (208 KB raw) plus the shared shaping/frontmatter/David Libre files once item 3 also moves.
3. **Booklet builder** (`buildBookletAction` -> `assembleBooklet`, plus `uploadFontAction`/`inspectFont`). Shares fontkit, `frontmatter`, `shaped`, all bundled fonts (about 450 KB gzipped) with item 2: after 2 and 3 fontkit and all font modules can leave the website. Its input is user files, so it benefits from phase 3 uploads but can work first through storage, as today.
4. **Link import and test print** (`importLinkAction`, `fetchPdf`/ssrf, `sendTestPrintAction`). Small and independent; removes `node:dns`/`node:https` and the SSRF fetcher from the website, and the last direct `pdf-lib` use in admin.
5. **Booklet preview** (`previewBookletAction`): reuses the same impose code as the print pipeline, so do it just before the pipeline.

**Too coupled to move cheaply (do last, as one piece):** `createPrintJob` (`submit`, `reprint`, `finishHeld`, `/api/gateway/jobs/finalize`). It is 694 lines where heavy PDF steps sit between policy, quota reservation, held logic, storage and the DB insert, and policy/quota need the page count produced by the heavy step. Moving it means splitting it into "prepare file" (server job) and "create job from prepared result" (website or RPC), and changing every caller, plus a new waiting state in the UI. Same for the agent protocol (section 4): the claim/status/release/lease-recovery logic is about 950 lines of route code and quota accounting that has to be re-expressed as SQL/RPC plus RLS before agents can talk to Supabase directly, and lease recovery needs a `pg_cron` home first.

**Order for phase 2 (key removal):** (1) per-server JWT + RLS + Realtime for the agent and the 3 s loop (biggest request saver: about 86,400/day/server, 86% of the free budget by itself); (2) gateway: files stop going to Supabase once phase 3 lands, so removing the key from the gateway can follow right after a short-lived storage policy, but also replace the shared `GATEWAY_SHARED_SECRET`; (3) lease recovery/cron into SQL.

## 8. Facts to remember
- The website talks to the owner PC today only through Cloudflare tunnel (docs/STATE-2026-11-01.md). Gateway default poll/status cache values above are as of this tree.
- The agent heartbeat does printer discovery locally each cycle (`health-monitor.ts` `discoverQueues` + raw probes), so slowing the heartbeat also reduces PowerShell work on the PC.
- Not verified: Cloudflare behaviour of Node compat (`node:crypto`), request-body limits, whether any legacy scrypt rows remain in `agents.device_secret_hash`, prefetch request counts, real bundle size after a Cloudflare build (do in phase 0).
