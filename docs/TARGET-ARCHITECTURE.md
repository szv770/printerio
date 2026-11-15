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
| Fonts for other schools | Ship only free-licence fonts (Ezra SIL, David Libre, EB Garamond, Source Serif 4, Libre Baskerville). The owner's licensed fonts (SBL Hebrew, OT Siddur/Vilna/Heilig/Holtz/Talmudis...) stay on the owner's own server, uploaded privately on the existing Admin -> Fonts page (so nothing licensed needs to go into git, and the repo can be private) |

## 3. What runs where
| Piece | Runs on | Notes |
|---|---|---|
| Pages, login screens, job list, admin screens | Cloudflare (free) | Dynamic requests count against 100,000 a day, 10 ms CPU each, 3 MB compressed bundle ([limits](https://developers.cloudflare.com/workers/platform/limits)). Static files are free |
| Logins, shared data, live push | Supabase | Free: 500 MB database, 5 GB traffic, pauses after a week idle ([pricing](https://supabase.com/pricing)). Today's database: 18 MB; daily study text about 94 KB a day, about 34 MB a year |
| Booklet builder, daily-study layout, page checks, imposition, thumbnails | Print server | Becomes "jobs" the server claims (like print jobs today); the website shows progress |
| Print dialog gateway, agent, files, retention | Print server | Already there; gateway must stop holding the master Supabase key (phase 2) |
| Timed jobs (cleanup, sweeps, keep-alive) | Cloudflare cron or Supabase timers | The PC no longer has to be on |
| Shared daily text and lists | Owner's server, a week ahead | One fetch a day for everyone |

## 4. Usage hot spots found in the current code (fix before moving)
- **Agent polls every 3 s.** Through the website that is about 28,800 requests a day per server (29% of the free daily limit each). Must go to Supabase directly with push.
- **Admin pages that auto-refresh every 2 s** (update banner, command refresh) would also count. Use Realtime or slower refresh.
- **Heavy libraries in the website bundle** (pdf-lib, pdfjs, fontkit, bundled fonts as base64) would break the 3 MB limit. They move to the server; the website imports none of them.
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
- **Fonts:** only free-licence fonts ship to schools; licensed fonts are uploaded privately for the owner's organization only.

## 6. Phases (each ends with something checkable; nothing is switched over until the end)
0. **Trial:** a tiny page on Cloudflare using the real Supabase login, built by GitHub on merge. Measure bundle size, CPU and requests per page; choose Cloudflare's current Next.js route (OpenNext vs vinext: Cloudflare now recommends vinext for new apps, [docs](https://developers.cloudflare.com/workers/framework-guides/web-apps/opennext/)) before committing. Exit: login works, numbers recorded.
1. **Heavy work becomes server jobs:** job states for building (booklet builder, daily study, preview, checks); servers claim them; the website shows progress or "print server offline". PDF/font code leaves the website bundle. Exit: the website builds without those libraries and everything still works through the PC server.
2. **Servers talk to Supabase directly:** per-server credentials, row-level security, Realtime push for jobs and commands, presence from heartbeats; remove the service-role key from the gateway. Exit: zero agent requests to the website.
3. **Files stay on school servers:** browser to server upload through the tunnel with short-lived tokens; retention on the server. Exit: nothing uploaded to Supabase storage.
4. **Add a print server and signed updates:** enrolment page, automatic tunnel and address, signed release pipeline, "Update now" without git. Exit: a second test server installed from scratch with no GitHub key.
5. **Shared text:** the owner's server fetches a week ahead on a schedule; old days pruned after about 60 days; library PDFs fetched by the building server. Exit: a day viewable with no outside fetch by the school.
6. **Cutover:** move `beta.printio.app` from the PC's tunnel to Cloudflare; keep the PC site as a fallback for a week; make the repo private; add the merge-only deploy; Supabase keep-alive; usage alert. Exit: the PC no longer runs the website.

## 7. Still open (decide when we get there)
- Cloudflare Pages vs Workers for hosting the built site (settle in phase 0).
- Names of the per-school addresses and what happens to the existing `*.szvtech.org` gateway address (devices already added the printer there).
- Exact Supabase credential design for servers (custom JWT claims vs a thin API on Cloudflare that only checks and forwards).
- Whether Realtime free limits (connections and messages) hold at 15 servers (should; verify in phase 2).
- Pricing and billing for schools; when to move to Supabase Pro and Workers Paid.
- While the repo is public, never commit licensed fonts; the repo stays public until phase 6.
