# Printio: the setup we are building (design)

Status: **draft for the owner's approval, 2026-10-20.** Nothing in "Phases" below is built until approved.
Read with [ipp-printing.md](../../ipp-printing.md) (IPP findings) and [kyocera-raw-print.md](../../kyocera-raw-print.md)
(proven printer settings). Do not re-derive those; extend them.

## Intent

Staff (teachers and others at the owner's organization) print from the normal print dialog on their own
phones and laptops, choosing things like double-sided and staple the way they would with any printer, with no
printer drivers to install. Printio receives the job, works out what they asked for, and sends it to the
Kyocera TASKalfa MZ8500i. If it cannot confidently work out what they asked for, the job is **held** and the
member or the owner picks the options on the website. Uploading a PDF on the website stays as a first-class
backup, and is where booklets are chosen explicitly. The owner can always see who printed what.

Why now: a booklet/staple-capable office printer is awkward to use from personal devices; the old design needed
one Windows queue per finishing combination. Raw printing on port 9100 removed that limit and is proven.

## The real setup (inventory, so nothing is built for an imaginary one)

- One printer: Kyocera TASKalfa MZ8500i, 192.168.100.168, raw port 9100. Single organization (the owner's), full
  multi-tenant schema underneath.
- **Server:** Windows 11 Pro PC ("MLM Office"), reached by Tailscale + Remote Desktop, on the printer's network
  (the owner's laptop is not). Runs the Print Agent. Will also run the IPP gateway behind a Cloudflare Tunnel.
- **Web app:** Next.js on Vercel, project `printio`, domain `printio.szvtech.org` (DNS on Cloudflare, domain
  `szvtech.org`). **Database/auth/storage:** Supabase project `printio` (free plan).
- Sign-in: Google or magic link (Google not yet enabled on the new project; magic link needs Resend before roll-out).
- Devices to support: Windows 11, Android (Pixel 8), Chromebooks (managed and personal), iPhone/iPad and Mac
  (not yet tested; Apple only by borrowing a device).
- The owner tests by walking to the printer. Every test print must be labelled on the page.

## Goals / non-goals / anti-goals

Goals: print from any member device with plain dialog options; correct staples and booklets in both binding
directions; per-user accountability; a website an admin can run without training; works on the real printer.

Non-goals (for now): color-cost billing, multiple printers or sites, push notifications (wanted later), payment.

Anti-goals (a failure even if it "works"): a job that silently prints with the wrong finishing; a member needing
a driver; an admin needing to understand profiles, queues or PJL; a settings screen with options that do nothing;
anything that prints twice by itself.

## Principles

1. **Never guess finishing.** Only send settings proven on the printer (packages/shared `pjl.ts`); anything else
   is held for a human. 2. **Raw port is the main path;** one Windows queue at most, as an admin-switchable
   fallback. 3. **Plain words everywhere** ("User", "printer", not "student", "profile", "queue").
4. **One name:** Printio. 5. **Test-first,** and every printed result confirmed with a labelled print.

## Proven printer settings (see kyocera-raw-print.md; do not change without a labelled test)

Plain PDF + PJL header to port 9100. Duplex `DUPLEX=ON BINDING=LONGEDGE`; copies `QTY=n`; staple (portrait):
top-left `STAPLEOPTION=ONE`, top-right `ONE` + `KFEEDEDGE=SHORTEDGE`, bottom-left `ONEOPPOSED`, same for one-sided;
booklet both directions `DUPLEX=ON BINDING=SHORTEDGE OUTBIN=KBOOKLET FINISH=KFOLD` with the PDF imposed by the app
(`imposeBookletPdf`, mirrored for right binding, normal sheet order); never `KREVERSEFOLD`.
Unverified: mono (`KCOLORMODE=MONO`), landscape pages, paper size/tray, punch.

## Member experience (the picture to hold in your head)

1. Owner invites a teacher (a link or email from Admin > Users). The teacher signs in once.
2. A short "Add Printio to your device" page shows the teacher's personal address and per-device steps (Windows,
   Android, Chromebook, iPhone/Mac later), with a copy button and, where possible, a one-tap profile.
3. They print from any app. Job options arrive as standard IPP attributes. The job appears on their "My jobs"
   page with a plain status ("Sent to the printer", "Waiting for you to choose options", "Needs approval").
4. If an option cannot be mapped confidently (finishing not offered, right-binding booklet from a dialog, odd paper
   size), the job is **held**: the member sees a clear card with the choices to finish it. Admins see all held jobs
   in one "Needs attention" list.
5. A small faint user code is stamped on page 1 of each printout (so the owner knows whose pile is whose).

## Connecting a device (a first-class feature, owner request 2026-10-20)

Members add their own devices from the website, with clear, short, good-looking steps (not a bare test page):
- **My devices** page: "Add a device" -> pick Windows / Android / Chromebook / iPhone / Mac -> one screen of
  numbered steps with a big copy button for that person's address, screenshots/illustrations, and a "Send a test
  page" button. Each device a member adds is a row (name, type, added date, status).
- **Status the system can see** (from the gateway): *address created*, *device connected* (the gateway saw the
  device ask for printer attributes), *first job received*, *first job printed*. This gives the admin the head start
  the owner wants: **connected but never printed** is shown as a problem to look at.
- **"I'm having trouble"** button on every device: the member picks what went wrong (couldn't add it, added but
  nothing prints, prints wrong, other) and may add a note. It creates a support item.
- **Admin > Devices:** one list of all devices with their status and every open "having trouble" item, sorted so
  stuck ones come first (e.g. connected, no print after 10 minutes), with the gateway's log of what that device sent
  (OS user-agent, requested options, last error) so the admin can see what went wrong. Admin can mark items
  resolved with a note, regenerate/revoke a member's address, and send the member a message.
- Needs: a `member_devices` table (per member, token reference, type, last_seen, first_job_at), a
  `device_issues` table (device, kind, note, status, resolved_by), and gateway-side event logging. Built in
  Phase 5 together with the gateway; the pages (My devices, Admin > Devices) can be built earlier against the
  tables, with the "connected" signals filling in once the gateway exists.

## Admin experience

Menus grouped: Overview, Printers, People, Rules, Reports. **Quick setup** for the printer: enter its address,
done (no profile/queue step). Admin signs in as themselves (no "student view"); "Student" is renamed "User" in the
interface only (the stored value stays `student`). Users page shows each member's code and can edit it. A
Settings section controls the stamp (on/off, what it shows, strength).

## Parts and how they connect

- **Web app:** member pages (Print, My jobs, Usage, Add to device), admin pages, intake pipeline
  (preflight, policy, quota, approval) -> `print_jobs`.
- **IPP gateway (new service, on the server):** Node service behind a Cloudflare Tunnel. Identity in the hostname
  (`u-<token>.szvtech.org`, one label so the free wildcard certificate covers it; the token is a random stable secret, NOT the editable user code, so editing a code never breaks a device and a code cannot be guessed). Receives Print-Job /
  Create-Job+Send-Document, maps IPP attributes to the same job record the website creates (`source = 'ipp'`),
  accepts everything and holds/rejects server-side with a readable reason. Per-member tokens hashed, revocable.
- **Agent (on the server):** polls the cloud, sends the PDF + PJL straight to 9100, reports
  `printing -> submitted_to_spooler -> completed`.
- **Shared:** `pjl.ts` (finishing -> PJL), policy engine, imposition. Gateway, website and Agent all use them.

## IPP option mapping and the main risk

From the dialog we reliably get copies, sides (one/two long/short edge), page ranges, paper size, orientation.
**Finishing is the unknown:** IPP carries it as `finishings` (e.g. 20 staple-top-left, 22 staple-top-right,
28 booklet-maker) but an OS dialog only shows staple/booklet if the printer advertises `finishings-supported`,
and we do not yet know which of Windows / Android / ChromeOS / Apple expose it or send it. Plan: advertise
none / staple-top-left / staple-top-right (booklet only if a platform surfaces it) and run a labelled spike per
platform before building the mapping. Fallbacks, in order: (a) per-member default finishing set on the website
("my stapled preset"); (b) hold the job and let the member choose in one tap; (c) separate virtual printers per
preset where the platform allows a path (Android takes a bare hostname only, so not there). Do not promise
dialog-level staple on every device until the spike proves it.

## Phases (each: tests first, build + tests green, merged by Claude, then the owner tests on real devices)

1. **Names and menus:** "User" wording, remove "switch to student view", one shared menu. *Accept:* no "student"
   visible; admin reaches Print and Admin without switching.
2. **Better upload page:** plain choices (sides, staple none/top-left/top-right, booklet none/left/right, copies,
   color/B&W, paper size, page range, live sheet/page summary, remembers last choice); staple position becomes a
   per-job field (migration + RawTarget); page range applied before booklet padding and cost math. *Accept (labelled
   prints on the real printer):* each staple corner, one-sided and double-sided, left and right booklet, page range.
3. **User code stamp:** member code (auto from initials + 2 digits, editable), stamped small and faint on page 1
   before booklet imposition; admin settings for on/off, what it shows, strength. *Accept:* stamp visible on a
   normal job and on a booklet cover; off means nothing stamped.
4. **IPP spike for finishings:** extend `tools/ipp-spike` to advertise finishings and log what Windows, Android and
   ChromeOS show and send. *Decision point:* which fallbacks are needed.
5. **IPP gateway MVP:** service, token table + migration, intake with `source='ipp'`, hold reasons, **My devices
   (add device, steps, test page, "I'm having trouble") and Admin > Devices (status, issues, logs)**, Cloudflare Tunnel with `u-<token>` hostnames. *Accept:* print from Windows and Android to the real
   printer, with held-job behaviour shown.
6. **Admin cleanup and Quick setup:** one-screen printer setup, grouped menus, plain wording, "Needs attention".
7. **Later:** push/email status notices (owner wants these), Apple profile, landscape and paper-size mapping, SNMP
   status, Google sign-in, Resend for sign-in emails.

## Decisions made by the owner

Name Printio; admins use the app as themselves; stamp is the user **code only**, small and transparent, with admin
settings for on/off, content and strength; staple choices none/top-left/top-right per job; left and right booklets
both supported; Realtime/IPP are core, not optional; Claude merges its own passing PRs; Supabase (not Neon).

## Calls I made (the owner can overrule)

Code format initials + two digits, editable; stamp top-right corner of page 1; "User" is a label change only;
Haiku for mechanical edits, Sonnet for build, Opus only for hard parts; keep `printerio` as the repo/folder name.

## Known issues to fix along the way

Live job status needed a page reload (Realtime on the new project untested); two agent tests fail on Windows
independent of this work; Supabase advisor warnings (rate-limit and email-domain functions, one search path).

## Resolved after an independent review (2026-10-20; Claude's calls unless marked)

- **Held jobs:** reuse `print_jobs` with a new status `held` plus a plain-language `held_reason` and the choices needed.
  The member who sent it, and any admin, can release it; it expires after 7 days (admin-configurable) and is then
  cancelled with a note. `held` (needs the sender's choices) is separate from `pending_approval` (needs an approver).
  This is a state-machine change in `packages/shared/src/job-state.ts`, written test-first in Phase 2.
- **Identity:** separate random token in the hostname, hashed at rest, revocable/regenerable, revoked when a member is
  deactivated. Authentication = knowing the token hostname; the user code is display-only.
- **Phase 5 scope:** planned up to the Phase 4 spike result; the "held, choose in one tap" fallback and per-member
  default preset are in scope regardless, because held jobs are needed anyway.
- **Stamping:** applied once, in the web intake pipeline, which the gateway calls for IPP jobs too (so website and IPP
  jobs are stamped identically). The Agent never stamps.
- **Formats:** the gateway accepts PDF only in the MVP (Windows, Android and ChromeOS all sent PDF). Anything else is
  held/rejected with a readable reason; conversion is a later add-on, not assumed.
- **Quota/approval for IPP jobs:** accepted first, then decided server-side with a readable reason on the jobs page:
  needs approval -> `pending_approval`; over quota -> `denied` (shown with reason); cannot map options -> `held`.
- **Gateway hosting:** a Windows service with auto-restart on the server, using a server-side Supabase service key
  (never in the browser). If the cloud is unreachable it answers IPP "server-error-temporary" so clients retry.
- **Unverified controls:** color/B&W and paper size are hidden from the upload page until a labelled test on the real
  printer proves them (one batch, run from the server). Everything shown on the page must do something.
