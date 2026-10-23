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
