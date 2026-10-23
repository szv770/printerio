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
