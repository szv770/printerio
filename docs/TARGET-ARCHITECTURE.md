# Target architecture (decided with the owner 2026-11-15) - a plan, nothing here is built yet

Read this before touching hosting, the agent/gateway link, uploads, updates or the library. It replaces the older idea that the owner's PC
runs the whole website (`docs/STATE-2026-11-01.md` section 1 describes how it runs TODAY; that stays until phase 6 below).

## 1. The rules (owner's words, tidied)
1. **Cloudflare only serves the website and forwards visitors.** No heavy work on it: no PDF building, no layout, no checking, no fetching of
   outside sites. Heavy work runs on a print server.
2. **Supabase** holds logins and the shared data. **Each school's print server** does printing, the print-dialog (IPP) gateway, PDF work and
   keeps that school's files.
3. If a school's print server is offline, the website still works (login, queue, admin) and anything needing the server says plainly:
   "Your print server is offline, so I can't do that right now."
4. Other schools can add their own servers by themselves, safely. Printio's code stays in a **private** repo; a school never gets a GitHub key.
5. Stay inside free tiers as long as honestly possible, watch usage, and move to a paid plan before a limit hurts a school.

## 2. Decisions made (owner answers, 2026-11-15)
| Question | Decision |
|---|---|
| Scale to plan for | 5-15 schools, about 1,000 people in the next year |
| Where PDFs live | On each school's own server. Browser uploads straight to that school's server through its Cloudflare tunnel. No cloud file storage, no download fees. Server off = uploading and viewing say "server offline" |
| Supabase | Stay free for now plus a tiny daily keep-alive (it pauses after a week of no use); Pro ($25/month) at the first paying school |
| How servers talk to the cloud | Straight to Supabase with live push (Realtime), never through the website. Per-server credentials; a school's server can only see its own school |
| Deploys | GitHub builds and deploys to Cloudflare only when a change is merged (no preview builds); one limited Cloudflare key stored as a GitHub secret |
| School tunnels | Printio creates one Cloudflare tunnel + address per school automatically when the school clicks "Add a print server" |
| Shared lists and daily-study text | The owner's own server fetches a week ahead on a schedule and saves to Supabase; schools only read the saved copy. Library PDFs are fetched by whichever school's server is building the booklet, at that moment, and are not stored in the cloud |
| Fonts for other schools | Everyone gets the free-licence fonts (Ezra SIL, David Libre, EB Garamond, Source Serif 4, Libre Baskerville, and more open fonts later). A school that wants a specific licensed font (for example SBL Hebrew, about $5) buys it and uploads it on its own Admin -> Fonts page (already built). The owner's licensed fonts (SBL Hebrew, OT Siddur/Vilna/Heilig/Holtz/Talmudis...) are never shipped to schools and never put in git; they are uploaded privately on the owner's own server, so the repo can be private |
| Standard daily booklets | The owner's server pre-builds the standard daily-study booklets a week ahead (Hebrew / English / both, Letter and 11x17, the house design, which may use the owner's licensed fonts; only the finished PDF leaves, and a PDF carries only the letters it uses, never the font file) and pushes them to every school's server. Any other choice (another font, language mix or size) is built on the school's own server with open fonts or fonts the school uploaded |
| How a finished PDF reaches a school | The owner's server pushes it to the school's server through that school's tunnel with a cloud-signed token (the same token mechanism as browser uploads). Nothing is kept in cloud storage. If a school's server is off, the job waits in the queue and is retried (a school's server has to be on to print anyway) |
| Cover, contents and back pages in the booklet builder | Unchanged: built on the school's own server from the school's own files with open fonts or the school's own uploaded fonts. (An idea to build only those pages on the owner's server was dropped.) |

## 3. What runs where
| Piece | Runs on | Notes |
|---|---|---|
| Pages, login screens, job list, admin screens | Cloudflare (free) | Dynamic requests count against 100,000 a day, 10 ms CPU each, 3 MB compressed bundle ([limits](https://developers.cloudflare.com/workers/platform/limits)). Static files are free |
| Logins, shared data, live push | Supabase | Free: 500 MB database, 5 GB traffic, pauses after a week idle ([pricing](https://supabase.com/pricing)). Today's database: 18 MB; daily study text about 94 KB a day, about 34 MB a year |
| Booklet builder, daily-study layout, page checks, imposition, thumbnails | The school's print server | Becomes "jobs" the server claims (like print jobs today); the website shows progress. Exception: the standard daily booklets are pre-built by the owner's server and pushed to schools |
| Print dialog gateway, agent, files, retention | Print server | Already there; gateway must stop holding the master Supabase key (phase 2) |
| Timed jobs (cleanup, sweeps, keep-alive) | Cloudflare cron or Supabase timers | The PC no longer has to be on |
| Shared daily text and lists, and the pre-built standard daily booklets | Owner's server, a week ahead | One fetch a day for everyone; the same server builds the standard booklets from that text and pushes them to schools |

## 4. Usage hot spots found in the current code (fix before moving)
- **Agent loop.** Every 3 s the agent makes THREE calls to the website (heartbeat, commands, claimable jobs: `apps/agent/src/orchestrator.ts:847-861`). That is about **86,400 requests a day per server, about 86% of the free daily limit for one school** (measured in the code 2026-11-15; an earlier version of this plan said 28,800, which counted one call). Must go to Supabase directly with push, and the heartbeat slows to 30-60 s.
- **Browser auto-refresh:** home and admin pages refresh every 30 s on any visible tab; the job list and job page every 4 s while a job is active; the print server page every 5-10 s (not 2 s as first written). Realtime already exists for `print_jobs`, `agents` and `remote_commands` (migration 0011) and three pages use it; make polling a slow backstop. Details: `docs/phase0-code-inventory.md`.
- **Heavy libraries in the website bundle** break the 3 MB limit. Measured 2026-11-15 (gzip): the real website as it is = 6.26 MiB with OpenNext and 3.63 MiB with vinext, both over the free 3 MiB; without the PDF and font code = 3.99 MiB (OpenNext) and 1.93 MiB (vinext); also without the icon-image library = 3.21 MiB and 1.04 MiB. So after phase 1 the website fits the free plan only with **vinext**. The PDF/font libraries (pdf-lib, pdfjs, fontkit, base64 fonts) are about 1.7 MB of the compressed size. Details: `docs/phase0-cloudflare-build-trial.md`.
- **Supabase storage (1 GB free)** is avoided by keeping PDFs on the schools' servers.
- **Builds:** Cloudflare free = 3,000 build minutes a month on Workers builds ([limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)); GitHub Actions on a private repo = 2,000 free minutes a month ([billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)) and our checks take about 3 minutes per run. Deploy only on merge; avoid needless pushes.
- Rough estimate to verify in the trial: 1,000 active people may use 20-50% of the daily free request limit. Rule: move to Workers Paid (about $5/month) when daily use passes ~70%, and set an email alert there.
- As understood (not verified): going over a free limit makes requests fail until the next day rather than charging.

## 5. Security model
- **Per-server identity.** Enrolling gives each server its own credential scoped to one school (a Supabase login carrying `org_id` and `agent_id`, enforced by row-level security). The school server never holds the service-role key (the gateway holds it today: `apps/gateway/src/config.ts`). Revocable per server.
- **Add a print server:** admin clicks the button; the cloud creates a one-time code (about 30 minutes, single use, hash stored), creates the school's tunnel and address, and shows one install command. The installer sets up the agent, which generates its own key and enrols with the code. The existing register flow (`docs/agent-api.md`) is the starting point.
- **Updates with no GitHub key:** CI builds and **signs** release bundles and publishes them somewhere public-read and free of download fees. The cloud only points a server at a version (URL + checksum + signature); the agent verifies against a public key built into it, installs, and rolls back on failure. Servers run no git. The cloud can never make a server run arbitrary code. "Update now" then works for every school.
- **Browser to school server uploads:** the cloud mints a short-lived upload token for one school; that school's server checks it (public key) and accepts only that school's users, with size and type limits and CORS for the website only.
- **Biggest new secret:** the Cloudflare key that creates tunnels and addresses. Scope it to the one zone and tunnels only, keep it only in the cloud function that needs it, rotate it, and make each school's tunnel revocable alone.
- **Shared text integrity:** schools only read the shared lists and daily text; only the owner's server writes them (so no school can alter what others read).
- **Fonts:** only free-licence fonts ship to schools; licensed fonts are uploaded privately for the owner's organization only (and by a school for itself). Technical check on the owner's fonts (2026-11-15): no font file forbids embedding or subsetting in a PDF (OT fonts: no restriction set; SBL Hebrew: editable embedding allowed). That flag is not the licence agreement: see section 7.
- **Pushing finished PDFs to schools:** the owner's design server is a signed-in sender with a cloud-issued, short-lived token naming one school; the school's server accepts it only for that school, with size and type limits, and the same upload endpoint as browser uploads (phase 3).

## 6. Phases (each ends with something checkable; nothing is switched over until the end)
0. **Trial:** a tiny page on Cloudflare using the real Supabase login, built by GitHub on merge. Measure bundle size, CPU and requests per page; choose Cloudflare's current Next.js route (OpenNext vs vinext: Cloudflare now recommends vinext for new apps, [docs](https://developers.cloudflare.com/workers/framework-guides/web-apps/opennext/)) before committing. Exit: login works, numbers recorded.
   **Result so far (2026-11-15, `docs/PHASE0-FINDINGS.md`):** the real website builds with both adapters; vinext is recommended (about half the size). Still to measure: real CPU per request (needs a throwaway Cloudflare free account and a Supabase test login) and the 50-calls-per-request limit.
1. **Heavy work becomes server jobs:** job states for building (booklet builder, daily study, preview, checks); servers claim them; the website shows progress or "print server offline". PDF/font code leaves the website bundle. Exit: the website builds without those libraries and everything still works through the PC server.
2. **Servers talk to Supabase directly:** per-server credentials, row-level security, Realtime push for jobs and commands, presence from heartbeats; remove the service-role key from the gateway. Exit: zero agent requests to the website.
3. **Files stay on school servers:** browser to server upload through the tunnel with short-lived tokens; retention on the server. Exit: nothing uploaded to Supabase storage.
4. **Add a print server and signed updates:** enrolment page, automatic tunnel and address, signed release pipeline, "Update now" without git. Exit: a second test server installed from scratch with no GitHub key.
5. **Shared text and pre-built booklets:** the owner's server fetches a week ahead on a schedule; old days pruned after about 60 days; library PDFs fetched by the building server; the owner's server builds the standard daily booklets a week ahead and pushes them to each school's server (retry queue). Exit: a day's standard booklet is on a school's server with the owner's server switched off.
6. **Cutover:** move `beta.printio.app` from the PC's tunnel to Cloudflare; keep the PC site as a fallback for a week; make the repo private; add the merge-only deploy; Supabase keep-alive; usage alert. Exit: the PC no longer runs the website.

## 7. Still open (decide when we get there)
- ~~Cloudflare Pages vs Workers~~ Workers, built with vinext (phase 0 result); still to confirm with a real deploy that CPU per request stays under 10 ms. vinext is new: it needs React 19.3.1+ (the app has 19.2.8), so a React upgrade is part of the switch.
- Names of the per-school addresses and what happens to the existing `*.szvtech.org` gateway address (devices already added the printer there).
- Exact Supabase credential design for servers (custom JWT claims vs a thin API on Cloudflare that only checks and forwards).
- Whether Realtime free limits (connections and messages) hold at 15 servers (should; verify in phase 2).
- Pricing and billing for schools; when to move to Supabase Pro and Workers Paid.
- While the repo is public, never commit licensed fonts; the repo stays public until phase 6.
- **Licence agreements:** check each font's actual terms (the OT fonts are from the OTZAR foundry; SBL Hebrew has SBL's own licence) for use in a service that produces PDFs for other organizations, especially if schools are charged. The pre-built house-design booklets are the only place licensed fonts reach other schools, and only as letters inside a PDF. If a licence does not allow it, the house design uses an open font instead; nothing else in the plan changes.
- Which open fonts to add beyond the five bundled (more Hebrew open fonts, for example other OFL Hebrew families) and which look is the house design.
