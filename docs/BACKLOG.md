# Owner backlog (what the owner has asked for, in priority order)

Written 2026-10-22 so nothing is lost between sessions. Read `docs/HANDOFF.md` first for what is built and proven.
Working rule from the owner: one agent at a time, go step by step, do not burn usage with many agents at once.

## State (updated 2026-10-23)
READ THIS FIRST. `docs/HANDOFF.md` is the original design hand-off (partly out of date); this file is the current truth.

### Proven on the real system
- Pixel 8 -> `u-<token>.szvtech.org` -> Cloudflare named tunnel -> IPP gateway (Windows service on the "MLM Office" server) -> web app -> Print Agent (Windows service) -> Kyocera raw port 9100. Printed and reported "printed" on the phone. PDFs with attachments now print (they are sanitized).
- Website upload printed (JOB-2026-000010). Weekly cleanup route, daily sweep, cancel/retry, security tightening (migration 0034) are live and verified in the database.
- Both services run by themselves (service launcher fix, PR #12). Update-from-the-website button exists (PR #29) but must be used for the first time by the owner; the server had to be updated by hand once to receive it.

### Built and merged (all in the default branch)
Gateway: finalize refusals, text job numbers + own integer IPP ids, request logging, plain-English phone job messages. Web: user-code stamp (9 pt, bottom-right, unique persistent codes per org, Admin > Settings controls), device delete, cancel own job / failure messages / Try again / auto-retry setting (migration 0035), approvers can approve own, attachment stripping, booklet fills the page + blank-pages answer fixes, server-side writes for print_jobs/usage/storage (migration 0034 applied), weekly cleanup. UI: new design system (phone-app feel with a printer character), one admin shell for all pages, closed-by-default sections, unified Save bar, redone teacher pages, redone admin pages (People, Printers & devices, Rules & limits, Reports, Approvals, Files, All jobs), real admin and teacher homes with 15 s live refresh. Dev-only preview route `/dev/preview` (404 outside development) for Playwright screenshots; Playwright lives OUTSIDE the repo (scratchpad).

### NOT proven yet (needs the owner at a device or printer)
- Windows 11 print-dialog client (the owner's laptop is behind a content filter whose DNS breaks the address: test from the server PC or another network).
- Printed output: stamp legibility at 9 pt, one LEFT and one RIGHT booklet (fold/staple after the scale change), staples top-right via the dialog, duplex from the dialog.
- The new UI with real data and real saves (Users save bar, rule/limit saves, approve/reject, Settings save bar). Only sample-data screenshots were reviewed.
- The first press of "Update this server".
- Magic-link sign-in with the new email template (the owner changed it; not confirmed), Google sign-in (never diagnosed).

### Next
1. Owner: print one left and one right test booklet; try the Windows 11 print dialog; press "Update this server" once; click through the admin pages and report anything off.
2. Final visual consistency pass over every page (Playwright, 375/768/1280) and fix leftovers (e.g. admin pages still using old patterns, tour anchors that no longer have an element).
3. Remaining review findings in `docs/REVIEW-2026-10-22.md` (Medium/Low): raw-port printers may show "Offline", reports/quota period timezone (school is Miami / America/New_York), invite defaults (1 use, 7 days), "Show older jobs" on My jobs, Vercel Server Action body size (~4.5 MB) for website uploads, gateway finalize idempotency, audit-event forging by members.
4. Later features the owner asked for: cancel a job AFTER it reached the printer; long-edge/short-edge and bottom-left staple choices; students on Chromebooks (quotas, Google admin) need their own design; iPhone/AirPrint only after Windows and Android are solid.

### Decisions already made (do not re-ask)
No per-option Windows printer queues. Booklet from the print dialog is held and the member picks Left or Right in one tap. Staple default top-left but the owner mostly uses top-right. Teachers can cancel their own job; approvers can approve their own; failed prints show what failed + Try again (auto-retry is an admin setting, default off). Time zone Miami; no quotas for staff for now. Stamp: faded but larger, unique codes. UI: simple, closed-by-default sections, excellent on phones, admin never leaves the admin shell. One agent at a time, step by step; owner is not technical: plain language, exact copy-paste steps, say plainly what is untested.

## Owner feedback of 2026-10-23 (every item, with the plan)
Rule from the owner: any setting that was never tested on real paper/devices must be LABELLED "not tested yet, may not work" in the UI; the owner will test over the next days and report. Admin account is the main one; teachers use phones.

### PHASE 0 - URGENT: booklets (owner reports the fix did not work)
Root cause found: `imposeBookletPdf` builds the booklet on a LETTER sheet (output = Letter landscape, two half-letter cells), so a Letter source page is shrunk to ~61% with big top/bottom margins. The owner wants FULL-SIZE Letter pages on 11x17 (Adobe-style): sheet = two page-widths (Letter pages -> Tabloid/Ledger 11x17; A4 -> A3). Keep the half-size-on-Letter booklet as an explicit second option. Needs: PJL paper = ledger for those jobs (unverified: label it), preview of the imposed result before printing, odd/even/page-range interplay, and Hebrew right binding must stay mirrored (proven, do not change order logic).
- Also asked: **Ledger booklet** (Letter pages into a booklet on 11x17, saddle stitch) and **full-size Letter with two staples on the left or right edge** (NOT saddle stitch; staple-dual-left / staple-dual-right; choose left/right for Hebrew).

### PHASE 1 - quick fixes and clarity (small, do in batches)
1. Collapsibles behave like an accordion: opening one closes the others on that page.
2. Admin retention: make "how long files are kept" prominent and editable; add a button to delete the files of jobs that were already printed (clear now), with confirm; consider deleting old job records too (admin only, confirm).
3. Devices show "Sent a print, not printed yet" and Overview flags "needs attention" although prints worked: `first_printed_at` is never set. Set it when a job from that device completes (agent status route); Overview must stop flagging.
4. Printer card says "not reported yet" while the queue below says "Online, server X": raw-port printers have no Windows queue status. Make the agent probe the raw port (TCP connect to host:9100, optionally PJL INFO STATUS) every poll and report printer online/offline; same for "print queues say not reported yet".
5. Printer setup wizard needs Cancel and Back buttons.
6. "Update this server": explain how it works and how secure it is (see Q&A below); show live progress (pulling, installing, restarting, done) and auto-refresh the "Recent requests" list (it stays "pending" until the page is reloaded; reloading the agent page once glitched to a blank page: investigate). BUG: first update at 04:18 UTC failed "pnpm couldn't be started": the agent runs as a service (no user PATH) and Node >= 20 cannot spawn .cmd files with shell:false; find pnpm explicitly (env override PRINTIO_PNPM_PATH + known locations) and run it with fixed args.
7. Failed jobs vs jam/toner: with raw printing a jam or toner change does NOT fail the job (the printer accepts the data and prints when ready). A job should only fail when the printer cannot be reached at all; treat "unreachable" as "waiting for the printer" with automatic retry and a clear message ("The printer is not available (off, offline or network). It will print when it is back."), and show a detailed message on the web.
8. Two names for one thing: "Audit log" vs "Activity log": use "Activity log" everywhere. "Show details" must toggle to "Hide details".
9. Two "devices" sections (My devices under My account vs admin "User devices"): rename admin one to "All devices" and add an "Add a device" button there that goes to the add flow. Pre-select the device type from the browser user-agent when adding a device (user can change it).
10. Copy: "Step-by-step help for Other is coming soon..." is unclear: say plainly "We don't have steps for this kind of device yet; it may not work." iPhone: show basic honest instructions: "iPhone printing is not set up yet, we do not expect it to connect right now; we are working on a proper solution for iPhones."
11. Google sign-in is down: grey the button out with "Coming soon".
12. Invites page: "Share" button that builds a friendly message ("You are invited to Printio...") with a link; opening the link pre-fills the invite code, the user types their email, gets the magic link and is in (no manual code copying). Needs a safe code-in-URL flow.
13. Do prints that arrive through devices (IPP) go through the rules? They must. They use createPrintJob (policy engine) like web uploads: verify with a test and keep it that way.
14. Rename/regroup leftovers noticed: owner says the UI is a real upgrade but "much more is possible": do a second design pass later.

### PHASE 2 - security review
A dedicated security agent reviews the WHOLE setup (web app, gateway, agent update path, cron routes, tunnel/hostnames, Supabase RLS/storage/functions, secrets handling, headers/CSP, rate limits, dependency risks, GitHub branch protection). Read-only report first, then fixes in priority order.

### PHASE 3 - features (not needed this week, but wanted)
- Upload several files, combine them, choose pages and order across files, preview, then next to print settings.
- Page choices: All / Odd only / Even only / ranges.
- A preview of the result for imposed documents (booklets, n-up) before printing.
- Add many more print settings, each marked untested until the owner confirms (short-edge duplex from the form, etc.).
- Real onboarding/help tour that opens the page and highlights the button it explains and waits for the click (later).
- Cancel a job after it reached the printer (later).

### Owner questions answered (keep for the UI copy)
- How is "Update this server" secure? Only an admin can press it. The website sends only a fixed "update" signal with no data. The server then runs fixed steps: `git pull --ff-only` (only fast-forwards from the repo already checked out there), `pnpm install`, restart the gateway, restart the agent. No command text ever comes from the website. Remaining risk: whoever can push to the GitHub default branch controls what the server runs, so protect GitHub with 2FA and branch protection.
- Why do jobs fail on a jam? They should not (see item 7).

## Work plan agreed 2026-10-23 (reliability, scale, settings) - do ONE batch at a time, pro-level, tested, honest about what is unproven
Scale: fewer than 45 teachers now, about 120 users if students join. Free Supabase/Vercel plans stay (owner: no paid plans). A lost job is acceptable (reprint). Email alerts later.

BATCH 0 (running first): booklets fill the statement-size page (content-aware crop, uniform per document), 'Booklet fit' setting, in-page preview. Owner prints one left + one right test booklet.

BATCH 1 - server-side reliability (web + gateway + agent):
1. A failure that cannot be proven real shows 'Waiting for the printer - status unknown' (never a plain 'failed'). Raw-port connect/write timeouts and 'printer busy' requeue with backoff and a clear message ('The printer is not available (off, offline or network). It will print when it is back.'). A jam/toner change must NOT fail a job: the printer buffers the data. Real failure only after a long window (configurable) and always with a Try again button.
2. Claim order: oldest first (ORDER BY created_at) in /api/agents/jobs/claimable.
3. Duplicate protection (idempotency) in gateway finalize: same device + same file hash within a few minutes returns the existing job instead of creating another.
4. Gateway caches per-job status for ~3 s (Android polls once a second).
5. Gateway concurrency guard: cap total in-flight upload bytes (~150 MB); beyond it answer a temporary 'The server is busy, try again in a moment' (IPP server-error-busy) with Retry-After; log it.
6. Lease sweep every 15 minutes (the GitHub workflow .github/workflows/cron-sweep.yml has the schedule ready/commented out; Vercel Hobby crons are daily only).
7. Server logs: gateway + agent logs rotate on the server disk (30 days / size cap); admin button 'Get recent logs' on the Print server page (fixed remote command, no payload, admin only); important server-side events (failures, updates, sign-in problems) are also recorded in the database because Vercel keeps only 1 hour of logs.

BATCH 2 - printer probing: the agent probes each raw printer every poll (TCP connect to host:9100, then PJL INFO STATUS / SNMP if available) and reports online/offline plus status text (paper out, jam, toner low, door open, busy) and what it is holding; fix 'not reported yet' on printer cards and print queues; show it on the Overview and the printer pages; 'waiting for printer' jobs mention the printer's real status.

BATCH 3 - security review of the whole setup by a dedicated agent (read-only report first, then fixes).

BATCH 4 - print settings expansion + TEST LAB: trays 1-4 + multipurpose, paper size and type, and many Kyocera options as PJL settings. Every setting is labelled 'Not tested yet - may not work' until confirmed. Admin 'Test lab': each test print carries a short code (like AW32) that decodes to the exact settings (store code -> settings JSON in a table, print the plain-words settings on the page too); the owner reports 'AW32 worked / came out wrong' and the label turns green for everyone. Also: dual-staple left/right on full-size Letter (edge staple, left/right choice for Hebrew), long/short-edge duplex choice, odd/even page selection, multi-file merge with page order and preview.

LATER: email alerts (agent/printer offline), onboarding tour that really opens pages and waits for clicks, cancel after the printer has the job, Google sign-in, iPhone, students/Chromebooks design, a free 'Download backup' (users, settings, rules) button.

## Original priorities

1. **Make the server run by itself.** Gateway and Print Agent as Windows services (auto start at boot, restart on crash), plus `cloudflared` (already a service). The agent's credentials may be stored per Windows user; if the service cannot read them, re-enroll it under the service account.
2. **Phone shows where a job is in ANY case.** Every web state and hold reason must give the IPP client a plain `job-state-message` / `status-message` (held, waiting for approval, waiting for printer, printing, printed, refused, failed, cancelled). Nobody has seen which messages Android or Windows actually display; verify on the Pixel.
3. **Weekly cleanup so the server never fills.** Purge stored PDFs of finished jobs older than 7 days (keep job rows), sweep orphan `gateway-intake/` objects, prune unbounded tables, clear agent temp files and cap logs; Vercel Cron weekly. Users can reprint from their dashboard until the file is purged; after that show a friendly "print again from the original" message. `print_jobs.expires_at` and `files_purged_at` already exist: check what is wired before building.
4. **User code stamp on every print.** A small faint code for the user on page 1 of each printed copy (all copies of one job carry the same code) so the owner can tell whose pile is whose. Applies to web and IPP jobs, must survive booklet imposition. Org Settings: on/off, what it shows, strength. See setup design doc Phase 3.
5. **Update the server from the Printio web page** (no SSH/RDP). The Agent already has a `CHECK_FOR_UPDATE` remote command (`apps/agent`); extend the idea so the same button updates the gateway too (pull the default branch, `pnpm install`, restart the services), with a clear result in the admin page. Needs care: never run arbitrary commands from the web; only the fixed update steps.
6. **Web app polish.** The owner wants the web app "fixed up in many ways". The list has NOT been written down yet. Ask the owner for it (or walk the admin and member pages together) and record each item here. Known already: admins should not have to leave their own dashboard for anything (My devices link now in the admin menu), the admin "Devices" and member "My devices" pages feel like two separate things.
7. **Windows 11 test** from a machine without the filter; then booklet left/right from the dialog, staples top-right, duplex long edge.
8. **iPhone / AirPrint**: only after Windows and Android are fully working (see HANDOFF "Still open").

## Decisions already made (do not re-ask)
- No per-option Windows printer queues/profiles. Left AND right booklets, duplex and staples go through the raw path (PJL + app-side imposition).
- Booklet from the print dialog: the job is held and the member picks Left or Right in one tap.
- Plain "staple" means top-left, but the owner mostly uses top-right. Bottom-left staple: not needed. Short-edge flip from the dialog stays held until tested.
- The Raspberry Pi is retired.

## Status: Batch 2 invites/devices PR (claude/batch2-invites)
Done: invite share link (/join?code=..., code carried through the magic link via ?invite= and a 1h cookie, auto-redeemed in the auth callback), invite states (active/used up/expired) + copy link/code + turn off, join page, redeem rate limit (per user 10 and per IP 30 per 15 min via check_rate_limit, no migration; F13); Google button greyed "Coming soon"; "Activity log" everywhere + Show/Hide details; "All devices" + Add device (opens /devices?add=1), device type auto-detected from the browser, clearer Other/iPhone copy; setup wizard Cancel/Back; first_printed_at now set when a device's job completes.
Untested on real devices: share sheet on Pixel/Windows, magic-link round trip with the invite (Supabase redirect allow-list must accept /auth/callback?invite=...; the cookie is the fallback but only works in the same browser), device type detection on real phones.
Migration 0038 (back-fill of first_printed_at) was applied to prod 2026-10-23.

## Install as an app + share into Printio (branch claude/wow-pwa-share) - status

Done: manifest (share_target, icons, shortcuts), minimal no-cache service worker (/sw.js) that takes a shared PDF into IndexedDB and 303s to /print?shared=id, fallback /share-target route, Print-page handoff banner (fills the existing file input, never auto-submits), install card (home, Me sheet, admin sidebar; iOS hint). Vitest tests for the pure parts; production-build Playwright checks of manifest, icons, sw.js headers, SW activation, simulated share (303 + IndexedDB entry), fallback route, kill switch.

Not proven: real Android share sheet / WebAPK install (install once from Chrome menu 'Install app', then share a PDF from Files), Chromebook, iPhone, Vercel production behaviour of /sw.js. The screenshots in printio-screens/pwa-*.png were taken but not visually reviewed. The dev preview showed 2 'Install Printio' buttons after opening the Me sheet (unchecked why). The SW limit is the 50 MB default, not the org's setting. A share made while logged out loses ?shared on the login redirect (file stays in the inbox for 1 hour). Full pnpm -r typecheck/lint/build not re-run after the last preview edit; web tsc, eslint and vitest (1263) passed before it.

## Update progress on the Print server page (branch claude/update-progress) - status

Done: opening a print server page quietly sends CHECK_FOR_UPDATE with payload `{mode:"check_only"}` (agent runs only fixed read-only git: fetch, rev-parse, rev-list, log; nothing pulled/installed) and shows "An update is available - Update now" or "Up to date". Update now runs the existing full update; the agent reports Checking / Downloading / Installing by POSTing `status:"progress"` to the existing ack route (writes `remote_commands.result`, no migration, never finishes the command or audits); the page polls every 2 s and shows Checking -> Downloading -> Installing -> Restarting -> Done. After the agent's final answer the page shows Restarting until the agent's next heartbeat is newer than that answer, then "Updated to <short commit>. Restarted."; 6 minutes of silence or a failed step gives a plain failure with Try again. Pure state logic in `apps/web/lib/update-progress.ts` (unit-tested), banner in `app/admin/agents/[agentId]/UpdateBanner.tsx`, dev preview `?section=updatebanner` and `?section=serverdetail&variant=available|installing|done|...`. No migration.

Not proven: a real end-to-end update on the server (the agent's new check/progress code only runs after the server has been updated once to this version, by the old button or setup-agent.bat). "Reconnected" is judged by a newer heartbeat, not by comparing a reported commit (the agent does not report its commit; that would need a column).

## Security: who can join + grants cleanup (branch claude/sec-web-db) - status

Done: org setting "Who can join" (Settings > Who can join): Invitation only (default for the existing org) or Invitation-or-school-email with an admin-managed domain list and a join role (student/staff, never admin). Enforced in Postgres by `join_org_by_domain()` (service role only; exact case-insensitive match on the VERIFIED auth email, no subdomains unless listed, never re-adds anyone who ever had a membership, audited). Auth callback: invite first, then domain join, otherwise a friendly "You need an invite" page (old domain sign-out gate and `email_domain_allowed*` calls removed; invited outsiders now get in). Unmatched accounts exist but are inert (RLS replay tests). Admin Users > "Sign-ups without access" lists them (email, signed up, last sign-in) with a confirmed Remove (service role, org_admin only, refuses members/admins/super admins/self, audit action `signup.removed`). Migrations 0039 (join policy) and 0040 (grants cleanup) + `supabase/verify/grants_audit.sql` (read-only, zero rows = clean). SQL is tested by replaying all migrations in PGlite (`apps/web/lib/db-test`).

Apply order on prod: 0039, deploy web, then 0040. Not proven: real Supabase (PGlite is a stand-in with stubbed auth/storage), a real magic-link round trip, Google sign-in (not enabled). No Supabase before-user-created hook (it would block invited outsiders); turning signups off in the dashboard is still an option if you only ever invite.

## Security batch S3/S4 (branch claude/sec-gateway-agent) - DONE, PR open
- F6 done: gateway resolves the device (cached; 30 s bounded negative cache) BEFORE buffering the body; unknown/revoked/unavailable devices are capped at 64 KB and refused at once with an IPP error; per-IP / global / unknown-token rate limits (CF-Connecting-IP only from trusted loopback peer); max connections, header size, header timeout, body-stall timeout. New optional env: MAX_CONNECTIONS, RATE_LIMIT_PER_IP_PER_MIN, RATE_LIMIT_GLOBAL_PER_MIN, RATE_LIMIT_UNKNOWN_TOKENS_PER_IP_PER_MIN, TRUSTED_PROXIES. Tests: gateway/test/hardening.e2e.test.ts, request-limits.test.ts.
- F6 NOT done: the gateway still holds the Supabase service-role key (needs web-issued signed upload URLs; apps/web change). Cloudflare-side rate-limit rule still recommended.
- F10 done: agent/src/input-validation.ts (safe job id, file name, queue name, https public download host, 120 MB cap, no redirects), copies capped 1..999 in shared pjl; hostile-input tests incl. numeric-IP / mapped IPv6 / rebinding for raw hosts. Optional env PRINTIO_DOWNLOAD_ALLOWED_HOSTS. Not closed: a public hostname that later resolves to a private IP (pin with the env allow-list).
- F12 done: agent/src/storage-acl.ts, icacls at start/register (SYSTEM + Administrators + interactive user). Pure parts tested; actual icacls run NOT verified on a real service install.
- F14 done: ci.yml permissions contents: read, actions pinned to SHAs verified with gh api; cron-sweep permissions {}. pnpm audit bumps skipped (not trivial).

## Members onboarding batch (branch claude/members-onboarding) - status 2026-10-23
Done (web only, 4 commits): (1) invite form picks a group; the person is added to it on joining; the invite row shows it; redeem re-checks the group is in the same org. Needs migration 0041 on prod (NOT applied). (2) Add device: Mac steps (Terminal `lpadmin` line with Copy, or System Settings > Add Printer > IP tab), labelled "Not tested yet - being worked on"; Mac is auto-detected from the browser. (3) Update banner shows "Installing - this can take about a minute" and a ticking "Time so far m:ss" counted from when Update now was pressed (the agent does not report when Installing began). (4) Users > person: Groups and "Printers they can use". There is no per-person printer list in the data model: this is the real result of the print rules (same evaluator the print path runs) for a normal 1-page black and white print, noted when a rule depends on job size/colour/time. Admin only (rules are admin-only under RLS). print_policies.applies_to_role is not read by the print path, so it is ignored here too.
Not proven: real Supabase for migration 0041 (replayed in PGlite only); Mac steps on a real Mac; the elapsed clock against a live update.

## "Did it work?" loop (branch claude/members-feedback, stacked on claude/members-onboarding) - status 2026-10-23
Done: after a member's first print from a device reached printed with no failed job and no open problem (within 30 days), a card on Home and My devices asks "Did it come out OK?" (Yes / Something was wrong + note). "Something was wrong" also opens a normal device problem (kind prints_wrong). Admin > All devices has "Does each way of adding a device work?": per setup method (Windows manual wizard, Android bare hostname, Mac lpadmin, plus any other device type that has answers) it shows Not tested yet / Reported working by N people / Confirmed working, the problem notes, and a button to mark that exact setup Confirmed working (audited as setup.confirmed). The setup method is filled in by the database from the device type, not by the browser. Migration 0042 (tables device_setup_feedback, setup_confirmations, RLS, explicit grants, never anon) is NOT applied to prod; until it is, the card stays hidden and the admin panel shows everything as Not tested yet.
Limits: the method is the one we show steps for per device type; for a Mac the card also asks which route was used (Terminal line or Settings IP tab) so each is counted and confirmed separately; one answer per device; "no errors" means no failed print job from that device, not a check of the paper itself.
Not proven: real Supabase for 0042 (PGlite replay only), the card against a real first print.

## Status 2026-10-25 (branch claude/connection-test-and-login, PR #48)
PROVEN on a real device: Windows 11 laptop added the printer via Add a printer > "Add a printer using an IP address or a hostname" > the FULL https address pasted > Next (~30 s "Contacting printer"). Job JOB-2026-000027 (`wPrintWindowsDoc`) reached the database as completed. "Select a shared printer by name" did not work. Earlier failure was NOT the finishings list (`ADVERTISE_FINISHINGS=basic` stayed unused; it remains as a diagnostic switch).
Fixed: gateway duplicate protection window 3 min -> 30 s (a real reprint of the same document within 3 min was silently swallowed while Windows said success).
Built, NOT tried on devices: sign-in code box + `/auth/confirm` page (needs the Supabase email template, `docs/email-templates/magic-link.html`); invite box takes a code or a link; device printer name `Printio-<printer>-<user code>`; "Test my connection" (migration 0043, applied to prod 2026-10-25) shown in the add flow and as a badge in Admin > All devices; iPhone setup steps + AirPrint profile download (`POST /api/devices/airprint-profile`) and AirPrint attributes (`image/urf`, `urf-supported`) advertised ONLY to devices created as iPhone/Mac.
Open: iPhone is a hypothesis (stale address + missing URF); needs a borrowed iPhone. Mac steps (lpadmin / IP tab) still untested. "Who sent it" label on printed pages. Booklet quality. CSP (report-only) does not list *.szvtech.org in connect-src; add it before the CSP is enforced.

## Status 2026-10-25 (later): proven devices, tour, booklets (branch claude/tour-banner-booklet-fixes)
PROVEN on real devices (database: print_jobs source ipp completed): Windows 11, Android, iPhone (`com.apple.PrintKit.PrinterTool`, JOB-2026-000036). Chromebook device created, never connected yet. Banner on both device pages is driven by `lib/devices/confirmed.ts` (edit only when a type has printed). Printer name + description follow `Printio-<printer>-<code>` for every device type (gateway resolves it per device; existing devices pick it up when the OS re-reads the printer).
Tour switched OFF (`TOUR_ENABLED=false` in `lib/onboarding-content.ts`): layout was hard to follow after the redesign and it auto-started for every new member. Rebuild and check on real pages before turning it back on.
Booklets: no more "add blank pages?" question (inline note + blanks added automatically). Preview was blank for scans because pdf.js 6 had no `wasmUrl` for JBIG2/JPEG2000 decoders: `scripts/copy-pdfjs-assets.mjs` copies them to `public/pdfjs` (dev/build), `lib/pdf/pdfjs-options.ts` passes the URLs; a page that cannot be drawn no longer blanks the rest. Scans: `content-analysis.ts` now renders image-only pages (via pdf.js's own Node canvas) and measures the real ink box; each scan is cropped on its own so it fills its cell whatever corner the ink is in.
Not proven: all of the above on the live site / real printer. If `@napi-rs/canvas` is not available on Vercel the scan measurement quietly falls back to the old whole-page behaviour.
