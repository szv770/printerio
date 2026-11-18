<!-- Approved 2026-11-16 with the owner. Companion to docs/TARGET-ARCHITECTURE.md (phases A-J). Update as items ship. -->
# Printio SaaS launch plan: from one school to 3-5 hand-held beta orgs, then open to more

## Context
Printio works for one school (Pixel 8 and website prints proven on the Kyocera TASKalfa MZ8500i). The owner wants other schools and companies on it quickly, with beta users who help find bugs, and with upgrades that reach every org without effort.

Decisions made with the owner (this session, 2026-11-16):
- **Beta:** 3-5 friendly orgs, hand-held. Payment is outside the app for now (Zelle or check). Stripe or Square comes later.
- **Printers:** the same Kyocera class first. Every NEW printer model must be proven with a labelled "test pack" that people report on, before it is offered.
- **Install:** the first 1-2 orgs get a remote install by the owner. The goal is a nice-looking Windows installer (.exe, a wizard, no terminal) so later orgs do it alone.
- **Gateway:** runs at each customer site, so **per-server credentials come first** (today the gateway holds the master Supabase key).
- **Roadmap:** follow `docs/TARGET-ARCHITECTURE.md` phases A-J as written, with the website on **Cloudflare now** (owner's pick).
- **Domain:** `printio.app` (not szvtech.org). `beta.printio.app` is the stable site and stays put. `printio.app` is the test site.
- **Release process:** staged. Owner's server first, then a beta channel, then everyone, with one-click rollback.
- **Polish first:** a docs page, real help, a site that survives a server outage, a first-run checklist, bug and feedback reporting. Docs are written so any AI can read them (a public docs site plus a plain-text copy to paste into Claude or ChatGPT). No built-in AI chat for now.

**Read this first: my first three audits ran on a stale checkout.** This branch (`claude/members-onboarding`) is 97 commits behind the default branch `claude/upcoming-large-project-3d2j9p`. Step 0 of the build is to merge the default branch in, then re-check the "re-verify" items below. Nothing in this plan changes code yet.

## What already exists (from default-branch docs; do not rebuild)
- Two-school isolation tests (phase A, PR #124) and the cross-school fixes (migration 0054).
- Agent traffic cut about 63%: one call per poll and a 30 s heartbeat (phase B, built, not yet run on the real PC).
- Server-job groundwork for heavy work (phase C1a-d, switches OFF).
- A self-host update path: "Update this server" also rebuilds the site on the PC (interim only).
- A full Print page: one-tap sides, edge, page size, paper type, booklet. A Library, a booklet builder and a Test Lab idea in the roadmap.
- Docs to reuse: `docs/TARGET-ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/DESIGN-REVIEW-2026-11-15.md`, `docs/PHASE-C-PLAN.md`, `docs/SECURITY.md`, `docs/TENANT-ISOLATION-TESTS.md`, `docs/staple-proving-plan.md`, `docs/agent-install.md`.

## Honest limits: what we can and cannot promise a beta org
| Limit | Plain truth |
|---|---|
| Printers | Only the Kyocera-class setup is proven. Other brands and models are "not supported yet" until a test pack passes. Staples, punch and booklets are driver and printer specific. |
| Always-on server | Each org needs an always-on Windows PC for its print server. If it is off, uploads and viewing say "your print server is offline" (the owner accepted this). |
| Phones | Windows and Android are the proven print-dialog paths. iPhone/AirPrint is not working. Mac and Chromebook are unconfirmed. Say so in the UI. |
| Printed output | Many options are built but never seen on paper (short edge, Tabloid, cardstock). They stay labelled "not tested yet". |
| Print confirmation | "Printer confirmed N pages" uses the page counter. Jam and toner are not detected per job. |
| Students | Student accounts, Chromebook limits and legal rules (FERPA/COPPA) need their own design and a lawyer's view before any school puts students on it. |
| Hosting costs | Free tiers have hard daily limits. Cloudflare Workers free allows 100,000 dynamic requests a day and 10 ms CPU each. Supabase free pauses and has no backups. Supabase **Pro ($25/mo) is required before the 2nd org joins** (owner decision). |

## Predicted problems (why each is likely, and what we do about it)
Sources: what we already hit, the design review, and what similar print-management products report. Items from other products are general experience, not verified here.

| # | Risk | Evidence | Mitigation (phase) |
|---|---|---|---|
| 1 | The website goes down and every org stops | 2026-11-16 PC outage; the site runs on one PC | Cloudflare hosting (H); an independent static status page now; the site says plainly when the print server is offline (C, F) |
| 2 | One org sees another org's data | Gateway holds the master key; some tables lack `organization_id` (re-verify) | Per-server credentials (D); isolation tests fail CI when a table is added without coverage (A, done) |
| 3 | A bad update breaks every org at once | Updates today are `git pull` on each PC; the update button was untested for weeks | Signed releases, auto-rollback, owner's server first, 48 h soak (G); a deliberately broken release drill on a VM |
| 4 | Install fails at the customer site | Setup needs Node, pnpm, git, SumatraPDF, services; "never tested on clean Windows" | A real .exe installer (see Track 4) that checks everything, plus a remote-install fallback; test on clean Windows 10, 11 and Server VMs |
| 5 | Antivirus or SmartScreen blocks the .exe | Unsigned installers are routinely flagged | Code-signing certificate (budget about $100-400/yr, price unverified); document allow-listing |
| 6 | Content filters break the address | Owner's own laptop filter broke the szvtech.org DNS | Ask each org to allow the domains; the "Test my connection" check names what failed |
| 7 | Print-dialog addresses collide across orgs | One wildcard DNS record points to one tunnel; second-level wildcards need a paid certificate (about $10/mo, unverified) | Redesign to one address per school with the device code in the path; prove it on phone, Windows and Chromebook before promising (E) |
| 8 | Supabase free limits hit | 500 MB database; pauses after a week idle; no backups | Pro before the second org; weekly copy and one tested restore until then (A) |
| 9 | Cloudflare CPU or bundle limit | The site is 3.6 MiB gzip on vinext, over the free 3 MiB; heavy PDF code is about 1.7 MB of it | Move PDF work to print-server jobs (C); trial on a throwaway account (E); $5/mo Workers Paid is the fallback |
| 10 | A new printer model "works" but prints wrong | Trays, paper type and cardstock all had surprises; a wrong size makes the printer wait and block everyone | Test pack and reports per model; unproven options hidden; only loaded paper sizes advertised |
| 11 | Sign-in emails not delivered | Supabase built-in email allows only a few per hour | Custom email sender before the second org; magic-link template is documented |
| 12 | Support load lands on the owner | One person, a non-technical admin at each org | Docs plus AI-readable copy; an in-app "report a problem" with logs attached; a status page; a weekly beta check-in |
| 13 | Legal and data issues | Student data; data in Supabase and Cloudflare | A short data agreement per org; get a lawyer's view before students; offboarding runbook (disable credential, delete tunnel, export or delete rows, wipe files) |
| 14 | A stolen or lost server | Servers hold a per-site credential | Revoke that one credential at once (D); a stolen-server runbook |
| 15 | Realtime free limits at 15 servers | About 1.3M heartbeat messages a month against about 2M free | Unpublished heartbeat table and a 60 s backstop |

## Build order (follows A-J; tracks 1-5 run in parallel because they do not need the infrastructure)

### Step 0: sync (before anything)
Merge `origin/claude/upcoming-large-project-3d2j9p` into the working branch. Re-run `pnpm -r typecheck lint test build`. Re-verify these items from my stale audits: org creation (a super-admin can create an org but not invite its first admin directly), the help tour anchors, the service worker (it caches nothing, so there is no offline shell), no health endpoint, no error tracker, no feedback form.

### Track 1: Safety and platform (the gated A-J spine)
- **A. Safety net:** weekly data copy plus one tested restore. Done in part (isolation tests). GO: tests pass in CI and a restore has been done once.
- **B. Quick wins on the PC:** run the already-built one-call poll and 30 s heartbeat on the real PC. GO: a week of clean printing.
- **C. Heavy work becomes server jobs** (library, daily study, booklet build, link import, preview), each behind a switch. Needed so the website fits Cloudflare's CPU and bundle limits.
- **D. Per-server credentials (the first blocker for outside sites):** servers get a narrow credential tied to one org. Gateway and agent stop holding the master key. Revoke one server at once. Replace `GATEWAY_SHARED_SECRET`. GO: the owner's own server runs it for two weeks and the two-school tests cover it.
- **E. Throwaway Cloudflare trial** (free account, no card, a second Supabase test project): measure CPU per request, key scoping, the wildcard/per-school address on a phone, Windows and Chromebook. Also decide the per-school address design (risk 7).
- **F. Files stay on the school's server:** the browser uploads straight to that school's server over its tunnel.
- **G. Signed updates and a second test server:** the release drill passes on a VM.
- **H. Website on Cloudflare under a new name** (never move `beta.printio.app`); a month of both running.
- **I. First outside school:** Supabase Pro on, data agreement signed, the tunnel made by hand first.
- **J. Retire the PC website** a month after H, only if clean.

> Honest note: following A-J as written puts the first outside org after D-H. That is the slow, safe path. To bring the first org forward, the gate that could be relaxed with the least risk is H/J (keep the PC site as the fallback for the first org). D and the isolation tests must not be skipped. This is the owner's call at the phase D gate.

### Track 2: Onboarding (runs in parallel; only needs the web app)
1. **First-run checklist** shown to a new org admin: add the print server, add the printer, run the test print, invite people, set rules. Each row shows a live status from real data (agent online? first job printed?).
2. **Create an org with its first admin in one step** from the platform area (today it takes "join as admin" then invite).
3. **Seed sensible defaults** for each new org (policy, groups, retention, time zone). Add an **org time zone** setting (quota periods currently assume Miami).
4. **Invite by link** with a pre-filled code (design exists in the backlog; verify it).
5. **Org-level readiness page:** shows the org's printer, server, gateway and test-pack status.

### Track 3: Help, docs and feedback
1. **Docs site** (public, plain Markdown in the repo): how Printio works, install, add a device, add a printer, what each setting does, troubleshooting by symptom ("my phone cannot find the printer"), limits, and a status page link.
2. **AI-readable copy:** generate one plain-text file (like llms.txt) from the docs at build time, plus a "Copy for AI" button on the docs page and in the Help dialog. Customers paste it into Claude or ChatGPT with their problem.
3. **Real contextual help:** the Help button opens help for the page you are on. Content moves out of the hard-coded tour file into per-page entries (a registry keyed by route and role), plus small "?" hints beside confusing fields. A "seen" flag is stored per user, not in the browser. Keep the guided tour disabled until each page is checked at phone width.
4. **Report a problem button:** one tap attaches page, role, app version and the last relevant job events (never secrets), and saves it to the database. Add an error tracker (Sentry free tier or similar; choose at build time) and a feedback inbox in the platform area.
5. **Version and "what's new"** shown in the app, so beta users know which build they have.

### Track 4: Windows installer
1. **Stage 1 (now):** keep `setup-agent.ps1`, wrap it in a clear checklist (what it checks, what it installs), and use it for the first 1-2 remote installs.
2. **Stage 2:** a signed `.exe` wizard (the tooling choice, such as Inno Setup or a Node single-executable, is decided at build time) that bundles Node and SumatraPDF, takes the pairing code, installs the agent and gateway as services, creates the limited `printio-svc` account by default, and ends with a green "everything works" screen. No git, no pnpm, no terminal.
3. Updates then come from signed release bundles (phase G), not git.
4. Test on clean Windows 10, 11 and Server VMs before the first outside install.

### Track 5: Resilience (the "site still up when the server is down" ask)
1. **Independent status page** on a separate host (static, free) showing site, database and the per-org server state. Add `/api/health` to the web app.
2. **Friendly offline and error pages:** a branded "Printio can't reach the server right now" page with what still works and when to retry.
3. **Service worker app shell:** cache the static shell and the offline page so the app opens when the network is bad. Today it caches nothing. Do not cache user data or authenticated pages.
4. **Clear "print server offline" messages** wherever a feature needs it (phase C/F), and email the org admin when their server or printer goes offline.
5. **What survives a cloud outage:** printing already received by the print server finishes; new submissions wait. Document this honestly.

### Track 6: Printer test pack (any new model)
1. A **test pack generator** makes a set of labelled PDFs (duplex long and short edge, each staple position, punch, booklet left and right, Letter and Ledger, mono and color, a text-fidelity page) with a short code on each page that maps to exact settings. Build on the existing test print (`apps/web/lib/pdf/test-print.ts`) and the staple proving plan (`docs/staple-proving-plan.md`).
2. **Admin sends it from the web** to the new printer through the existing raw-print path. Only loaded paper sizes are used so the printer never waits on empty trays.
3. **People report per code:** "worked / came out wrong / did not print", with an optional photo. A results table stores printer model, code, settings, verdict and who reported.
4. **Capability gating:** a setting turns on for that model only after it has a "worked" verdict. Unproven options stay hidden or labelled "not tested yet". Global green status (shared across orgs) comes after an admin review.
5. **Read what the printer says it supports** (the PJL inquire tool already exists in `tools/raw-print`) and store it with the model.

### Track 7: Beta program and releases
1. **Beta group:** 3-5 orgs. A short agreement covers what is in scope, no uptime promise, data handling and how to leave. Payment is arranged outside the app.
2. **Release channels:** owner's server, then beta orgs, then everyone. Each release has a version, a changelog line and a rollback. Owner's server soaks for 48 hours (phase G).
3. **Feature switches per org** so a risky feature can be on for one org only.
4. **Beta rhythm:** a short weekly check-in, a visible "known issues" page, and a triage list (crash, wrong print, confusing, wish).
5. **Per-org usage and limits** (jobs, storage) recorded now, with a plan field so billing can be added later without a rewrite.
6. **Offboarding runbook:** disable credential, delete tunnel and address, export or delete rows, wipe files. Verify that every table cascades on org delete (not yet verified).

## Rough timing (estimates, not promises)
- Tracks 2, 3 and 5 (1-3): about 2-4 weeks of focused work, no real-device dependency except the tests.
- Phase D: about 1-2 weeks of build, then a two-week soak.
- Phases E-H: several weeks, mostly waiting on trials and the month of side-by-side running.
- Installer .exe (Track 4 stage 2) and test pack (Track 6): about 2-3 weeks each.
- First outside org (phase I) therefore lands in roughly 2-3 months if A-J is followed as written. Remote installs for the first 1-2 friendly orgs could start sooner only after D and the isolation gates pass.

## Needs the owner
- Real-device tests (the existing backlog), a clean Windows VM, and a code-signing purchase.
- A new Supabase project for the test site, a Supabase Pro upgrade before org #2, and a throwaway Cloudflare account.
- A data agreement template and a lawyer's view before any student data.
- A custom email sender decision.

## Verification (how each piece is proven)
- `pnpm -r typecheck lint test build` after every merge.
- Two-school isolation tests stay green and fail closed (phase A/D).
- Playwright screenshots at 375, 768 and 1280 widths for checklist, help and offline pages (`/dev/preview`).
- Kill the database or server on staging and confirm the offline page, the status page and the "print server offline" messages.
- Broken-release drill on a VM: the agent rolls back by itself.
- Clean-Windows install test of the .exe, then the real printer test pack with a reported verdict for each code.
- Nothing is called "working" in the UI until it printed on a real device. This is labelled as untested in docs and UI.

## Critical files and references
- Phases and decisions: `docs/TARGET-ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/DESIGN-REVIEW-2026-11-15.md`
- Org creation: `apps/web/app/platform/organizations/new/actions.ts`, `apps/web/lib/auth/invitations.ts`
- Help and tour: `apps/web/components/help/HelpMenu.tsx`, `apps/web/components/help/SpotlightTour.tsx`, `apps/web/lib/onboarding-content.ts`
- Resilience: `apps/web/lib/pwa/sw-source.ts`, `apps/web/app/error.tsx`, `apps/web/app/global-error.tsx`
- Agent and installer: `apps/agent/src/self-update.ts`, `apps/agent/scripts/setup-agent.ps1`, `docs/agent-install.md`
- Gateway: `apps/gateway/src/config.ts`, `apps/web/lib/gateway/http.ts`, `apps/web/lib/env.ts`
- Test print and profiles: `apps/web/lib/pdf/test-print.ts`, `apps/web/app/admin/printers/actions.ts`, `packages/shared/src/pjl.ts`
- Migrations: `supabase/migrations` (numbered; mirror each into `schema.sql`; each new table needs an explicit grant)

## Status log
- 2026-11-18, Step 0 done: default branch merged into `claude/members-onboarding`. typecheck, lint and all tests pass (shared 214, gateway 207, agent 612, web 222 files).
- FOUND: `pnpm --filter @printio/web build` fails with `SecurityFatalError` because Next 16.4.2 has a known security advisory (same on the default branch; package.json pins `^16.4.2`). The backlog already lists the 16.4.2 -> 16.4.6 patch upgrade; do it first, with tests, before any deploy.
