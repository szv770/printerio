# Owner backlog (what the owner has asked for, in priority order)

Written 2026-10-22 so nothing is lost between sessions. Read `docs/HANDOFF.md` first for what is built and proven.
Working rule from the owner: one agent at a time, go step by step, do not burn usage with many agents at once.

## State (updated 2026-10-22, late)
- PROVEN on real devices: Pixel 8 -> `u-<token>.szvtech.org` -> Cloudflare tunnel -> gateway on the "MLM Office" server -> Supabase intake -> web pipeline -> Print Agent -> Kyocera raw port 9100. The phone showed "printed".
- Built and merged since: gateway job-number fix, plain-English phone job messages, Windows service launcher fix (services not yet confirmed running on the server), weekly cleanup, user-code stamp (bottom-right, migration 0033 applied), sign-in link fix (owner still has to change the Supabase Magic Link email template), device delete, flaky test fixed.
- NOT yet proven: Windows 11 client, staples/duplex/booklets from the dialog, the stamp on a real print, the services after a reboot, iPhone.
- A harsh review of the web app is in `docs/REVIEW-2026-10-22.md` (32 ranked findings). The RLS findings 1-3 were VERIFIED against the live database on 2026-10-22.

## Work order from the review (do ONE step at a time)
A. SECURITY (verified live): members can write any column of their own print_jobs (self-approve, forge jobs), write their own monthly_usage rows (reset quota; adjust_monthly_usage is SECURITY INVOKER), and read/overwrite every colleague's PDFs in storage (policies check only the org folder). Fix: move those writes server-side (service role, checks in code), deploy that FIRST, THEN apply a migration dropping the member write policies / scoping storage to the job owner and approvers. Re-check pg_policies before and after.
B. RELIABILITY: failed jobs never retry and keep their quota reserved; sweep only daily (re-enable the 15-minute schedule); members cannot cancel their own job from the website; last admin can demote themselves; held print-dialog jobs other than booklets are a dead end; website uploads over ~4.5 MB likely fail on Vercel (Server Action body cap); agent status route not idempotent; approve/reject can race with the sweep.
C. QUICK WINS from the review's list (invite defaults 1 use / 7 days, "Show older jobs", aria-labels, OAuth failure redirect, LocalTime in audit log...).
D. OWNER DECISIONS needed: can members cancel their own jobs; can approvers approve their own jobs; is Staff distinct from User; auto-retry on failure or ask the teacher; school time zone and quota reset day; 30-day forced re-login; restrict sign-in links to approved domains.

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
