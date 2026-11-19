# Printio: features, pitch and share text

> **Keep this file true.** Every time a feature ships (or is proven, or is pulled), update it in the same pull request.
> Status words used below: **Proven** = seen working on a real device or printer. **Built, testing** = it is in the
> code and tests pass, but nobody has seen it on a real device or on paper yet. **Planned** = not built.
> The public home page (`apps/web/lib/landing-content.ts`) and the in-app "confirmed devices" banner
> (`apps/web/lib/devices/confirmed.ts`) are the two places that repeat these claims; change them together.
> Last updated: 2026-10-26.

---

## 1. The pitch (use this to explain it to anyone)

**The idea in one line.** Press Print on any phone or laptop and it comes out of the right printer, with the rules,
approvals and booklet-making a school or office actually needs.

**The problem.** Printing in a school or office is a mess. Every device needs drivers and a printer on the same
network. Staff email files to someone who prints them. Nobody knows whose pile is whose, who printed 400 pages, or
why a job vanished. Booklets (the thing schools print most) come out with tiny text and wrong page order, and
right-to-left languages like Hebrew are an afterthought.

**The answer.** Printio puts the printer in everyone's normal Print menu on Windows, iPhone and Android, through a
private address per device. Jobs go to a small program in the building that talks to the printer directly. An admin
sees every device and every job, sets the rules, and can switch any device off.

**The greatest features**

1. **The normal Print button, on every device.** No app to learn, no driver to install. Proven on Windows, iPhone and Android.
2. **Booklets done properly.** Left binding for English, right binding for Hebrew. Pages are scaled as large as they fit
   without cutting anything off, even for scans of mixed sizes. A larger 11x17 booklet is being tested.
3. **Whose pile is this?** Every page and print job carries the sender's short code.
4. **You always know where your job is.** Waiting, printing, printed or held, with a plain reason and a one-tap retry.
5. **Rules without the headache.** Groups, page limits, approvals, invite links, an activity log.
6. **Setup that explains itself.** Step-by-step instructions per device, plus a "Test my connection" check that says
   whether the network is the problem.
7. **Runs on the building's own print server.** The printer never faces the internet.

**Who it is for.** Schools, yeshivos, offices and community organisations with one or a few shared printers and a mix
of Windows, iPhone and Android devices.

**Why it is different.** Most print-management products are built for large companies, charge per seat, and treat
booklets and right-to-left text as edge cases. Printio is built around the real day-to-day jobs of a school office.

**Business ideas (not decided, not built).** A monthly price per printer, with a free trial month; a school-year plan;
a hosted option that needs no server in the building. Pricing and billing do not exist yet.

---

## 2. Feature list

### Printing

| Feature | Status |
|---|---|
| Print from the normal Print button on Windows 11 | Proven |
| Print from the normal Print button on Android | Proven |
| Print from the normal Print button on iPhone (AirPrint profile) | Proven |
| Print from the normal Print button on Mac (Terminal or IP tab steps) | Built, testing |
| Print from the normal Print button on Chromebook | Built, testing |
| Upload and print a PDF on the website, with page ranges and a preview | Proven |
| Large PDFs (over about 3.5 MB, e.g. a 14 MB booklet) upload straight to storage instead of through the server (Vercel rejects bodies over ~4.5 MB); the booklet preview is fetched by link instead of inside the response | Built, testing |
| Double-sided (long edge) and single-sided | Proven |
| Flip on the short edge from the print dialog | Built, testing |
| Staple top-left or top-right | Proven |
| Two staples on the left edge ("Two staples, left"; print dialog finishing 28, website choice) | Built, testing. The printer settings are proven by labelled prints (2026-11-01, single-sided, portrait); the whole path (dialog -> gateway -> website -> Agent 0.2.1) has not been run through the real dialog/agent. Held with a plain reason: double-sided (labelled print P3 on 2026-11-01 gave ONE top-left staple, not two on the left, so it is not released), booklet, short-edge flip, landscape pages, together with hole punch |
| Hole punch, 3 holes on the left edge (print dialog finishing 5 / 78, website switch) | Built, testing. Settings proven by labelled prints (2026-11-01: single-sided, double-sided long edge, and with a top-left staple, all portrait); whole path not yet run through the real dialog/agent. Needs the printer profile's Hole punch capability switched on by an admin (off now, so it is held). Held: punch with a top-right or bottom-left staple, booklet, short-edge flip, landscape, together with two staples. The list lives in `PROVEN_FINISHING_COMBOS` (packages/shared/src/pjl.ts) |
| Booklet, left binding and right binding | Proven |
| Booklet: pages scaled to fill, blank margins trimmed | Proven (on text documents) |
| Booklet: scans measured so each scan fills its cell | Built, testing |
| Booklet: no question about blank pages, an inline note instead | Built, testing |
| Booklet: preview that draws scanned pages | Built, testing |
| 11x17 booklet with Letter pages at full size | Built, testing |
| Duplicate protection (a repeat click within 30 seconds does not double print) | Proven |
| A jam or toner change does not fail a job; waiting-for-printer state | Built, testing |
| Printer feedback over port 9100: the job says "Printer confirmed N of N pages" (or that the printer needs a person) from the printer's own page counter (read before the job, then a few short checks: it must rise by the job's pages) and from the printer's JOB END message when one is caught (unique job name). The Agent sends the job as usual, then makes a few short checks (the first about 10 s after, then every 10-20 s; each may show as a job-log entry on the printer). Proven on the real printer with a test script (8 pages confirmed in about 30 s); someone else printing at the same moment can only make it look further along. Agent setting PRINTIO_PRINTER_FEEDBACK, on by default (set false to switch off); tested against a fake printer replaying the measured behaviour; the first design (listening on the open job connection) proved unreliable on the real printer and was replaced; **not yet run end to end through the real Agent** | Built, testing |
| Hebrew safety check: every file Printio rewrites (attachment removal, page range, booklet, stamp) is compared with the upload; if its Hebrew (or other non-Latin) text would change, the job is held with a plain reason and nothing is sent. Tests show no current step changes Hebrew text or fonts; the check only runs when a derived file exists and the upload has non-Latin text, is limited to a few seconds, and never blocks a job just because the check itself failed | Built, testing. **Not tested on the real printer**: how the Kyocera draws Hebrew in Type 3 / unusual CID fonts is unknown (see docs/kyocera-raw-print.md, Hebrew and fonts; test files from tools/raw-print/make-hebrew-tests.mjs) |
| Share a PDF or a photo (JPEG, PNG) into Printio from the phone's share sheet (installed app; Android, works on mobile data because it only needs the website; iPhone Safari has no web share target) | Built, testing. Not yet tried on a real phone; the file type is checked by its first bytes |
| Pages per sheet (2 or 4) and the same page repeated 2 or 4 times on a sheet with optional cut marks (website Print page; the print server lays the pages out) | Built, testing. Checked with generated files only; not yet printed on the real printer. Not combined with booklet. |
| Print a photo (JPEG or PNG) from the website: the print server turns it into a one-page PDF (photo rotation read, very large pictures refused) | Built, testing. Not yet printed from a real phone or printed on the real printer. |
| Quick settings on the Print page, and booklet / pages-per-sheet presets inside the ONE printer on a phone or laptop: the print dialog's Paper type list offers 'Booklet - right edge, stapled', 'Booklet - left edge, stapled', '2 pages per sheet', '4 pages per sheet' and 'Same page twice per sheet (cut in half)'; a paper type the printer no longer offers holds the job with a plain reason | Built, testing. Which devices actually show a Paper type list is NOT yet tested; the gateway at each school must be updated to offer it. |
| Tap-to-pick pages: tap page thumbnails (with All / First page / Last 3 / Odd / Even / Swap / Clear) or type the range; both stay in step | Built, testing |
| Print from a link to a PDF (public link or Google Drive / Docs file), admins plus anyone with early tools on; fetched safely on the server and placed in the normal Print form | Built, testing |
| Booklet builder (admins, plus anyone an admin switches early tools on for): combine up to 12 PDFs or links into one booklet with a name, description, cover and contents page (Hebrew right-to-left supported), pick pages per file, reorder; then the normal Print screen takes over with the booklet switched on | Built, testing. Not tested yet on paper |
| Approvers' own jobs are approved automatically (a "deny" rule and quota limits still apply to them); disclosed on the job like the admin bypass | Built, testing |
| Booklet builder back page: a small "Courtesy of ..." line (for example Sichos In English (sie.org)) and an optional one-line sponsor, printed on the last page; it only uses the blank pages a booklet needs anyway, so it never adds paper (otherwise the credit stays on the contents page) | Built, testing |
| Your own fonts, and Hebrew titles: an org admin uploads .ttf/.otf fonts (Admin -> Fonts, private to the organization, never in the repo, so licence-restricted fonts such as SBL Hebrew can be used); each is tagged Hebrew and/or English by the letters it covers. The Daily study form and the booklet builder offer a "Hebrew font" (the text; Printio's Ezra SIL stays the default), a separate "Title font" for the Hebrew titles (for example a heavy display font), and an "English font" (a few bundled open fonts, David Libre by default, plus your own uploaded English fonts). Hebrew titles follow the Language choice: the study names (חומש, תניא, היום יום, רמב״ם), the Chumash parsha name and the Hebrew date. A font that lacks the trop or vowels the text needs is flagged, never silently dropped | Built, testing. Rendered to PDF and looked at with 10 real fonts; the title font, the English fonts and the Hebrew titles are not looked at on paper and not printed on the real printer yet |
| A job the printer has accepted says "Sent to the printer" with a small note that it may take a few moments to start printing (instead of "Done. It printed."), on the web, in job lists and on phones | Built, testing |
| Printer feedback: once a minute the print program asks each direct-port printer how it is (the printer's own status answer, over the same port; never while a job is being sent). People see the printer's own words when it needs someone ("Add paper in cassette 2") on the Print screen, on a waiting job, and on the admin Printers page and home | Built, testing. Printer answer proven live 2026-10-28; a real paper-out or jam message not seen yet |
| Early tools switch: an admin can turn the link import and the booklet builder on for one named person (Admin -> Users -> that person), so staff can help test; off by default | Built, testing |
| Booklet builder keeps your files while you visit the library to pick more and come back; after building, "Save a copy (PDF)" gives the normal page-by-page PDF (not the folded layout) to keep and upload again later | Built, testing |
| Library browser (early tools): browse Mafteiach's Likkutei Sichos by volume and parsha, maamarim and sichos by year, tap the files you want (Hebrew, translated, unedited, notes), then they go into the booklet builder with "Courtesy of Mafteiach (mafteiach.app)" on the contents page | Built, testing. Not tested yet on a real admin session; the Mafteiach team has not been asked |
| Library: search box on every list, an "English" badge where a real English file exists, plain button names ("Original sicha", "Translated to Hebrew": מתורגם means translated INTO Hebrew, not English) | Built, testing. Not seen on a phone yet |
| Library "Sichos In English" tab: the 111 published SIE Weekly English translations of Likkutei Sichos (by volume and book), each a Google Drive file, credited "Sichos In English (sie.org)"; a copy of SIE's page from 2026-10-26, refreshed by hand | Built, testing. Owner has SIE's permission |
| Admin button "Check for new weeks" in the Sichos In English tab: reads SIE's public weekly page, adds any new week (reading its first and last pages for volume, page and where the content starts and ends) so everyone with the library sees it | Built, testing. Not pressed on the live site yet |
| English translations sit inside the Likkutei Sichos list: each sicha shows an "English (SIE)" button next to the original and the Hebrew translation when SIE translated it (matched by volume and page, read from each SIE file); SIE files are used from the first real page to the last, skipping the cover, blank page and dedication pages at the front and the blank page, copyright credits page and back cover at the back | Built, testing. 111 of 111 SIE files matched to a volume and page; match to Mafteiach checked on volume 1 (35 of 38 exact, the rest by page range) |
| Library: "Print this file" for a single choice goes straight to the Print screen; "Make a booklet" (the wizard) only when asked | Built, testing |
| "Print again" opens the Print page filled in, as if the document had just been uploaded there: the job page's main button goes to `/print?again=<job>`, which shows a banner ("Printing again: <file>. Same settings as last time (...). Change anything below."), the file name, page count and preview (the stored original is fetched by the browser from a 5-minute signed link, not re-uploaded) and every choice set to what that job used (sides and short-edge flip, copies, paper, staple corner or two staples, hole punch, booklet side / fit / sheet, page range, colour). Everything stays changeable and Print goes through the ordinary pipeline (rules, quota, held reasons). A small "Same settings, print now" button beside it keeps the one-click behaviour. If the file was removed (a few days after printing) or the job is not yours, the page says so plainly and shows the normal empty form. Only the person who sent the job can use it. Also fixed: the one-click re-print used to drop the short-edge flip and 11x17 paper on a direct-port printer; it now carries every finishing choice | Built, testing. Not tried on a real device or against the real storage link; the jobs list still has its own one-click "Print again" |
| The Print page starts clean every visit (single-sided, 1 copy, all pages, Letter, plain paper, no staple, no punch, no booklet, black and white) instead of restoring the last choices from the browser. A per-person setting on the Profile page, "Remember my last print choices" (off by default; "Start the print page with what I chose last time (booklet always starts off)"), brings back the last submitted job's choices, except the booklet. Stored per user on the server (`user_print_preferences`, migration 0056, own row only), written only after a job is submitted while the setting is on. The handoffs (booklet builder, library page range, shared / built file, Print again) still win over remembered choices. Works without the migration: a missing table means the setting is off and the Profile checkbox is hidden | Built, testing. Migration 0056 is not applied to the live database yet (apply it in the Supabase SQL editor to get the Profile setting); not tried on a real device |
| Quick controls on the Print page, one tap each: Sides (Single-sided / Double-sided) and, once Double-sided is chosen, Flip on (Long edge, like a book / Short edge, like a notepad); Booklet (Off / Left binding / Right binding) that overrides everything in one go (double-sided, no staple, no punch) and shows only the booklet options under it. Nothing is greyed out because of another choice: a tap switches what it cannot live with and the live summary line says so in plain words ("Single-sided because hole punch with a staple needs it.", "Staple turned off because a corner staple can't be placed with a short-edge flip yet."). The rules are pure functions (`apps/web/lib/print-choice-rules.ts`, table-tested, and checked against what the server holds) | Built, testing. The printer setting for the short edge is proven (labelled print); the new form control, and a short-edge job sent from the website, have not been seen on paper yet |
| Page size on the main row: Letter or Tabloid (11x17), non-booklet as well as booklet (sent as PAPER=LEDGER; a booklet's sheet follows the same choice). Shown only when the printer declares 11x17 | Built, testing. A Tabloid job that is NOT a booklet has not been printed from the website yet (the print dialog's Ledger path is the same setting) |
| Paper type on the main row: Plain or Cardstock. Cardstock is asked for with MEDIATYPE=CARDSTOCK so the printer takes it from the bypass tray (Letter only, never with a booklet or Tabloid); the form warns "Uses the bypass tray: load cardstock there first, or the printer will wait and hold up other jobs." Stored as `finishing.paperType` (no migration; absent = plain); Print again restores it; a plain job sends exactly the PJL it always did | Built, testing. **Cardstock is UNPROVEN**: the MEDIATYPE value is one the printer lists, but no cardstock job has been seen coming out of the bypass tray (an earlier one never came out). Test with `node tools/raw-print/run-cardstock-round.mjs` before relying on it; needs Agent 0.2.2 or newer |
| Booklet wizard: choose Letter or Ledger 11x17; the Print screen opens with the right binding side (Hebrew = right) and the chosen size | Built, testing. The printer is told to use 11x17 paper (PAPER=LEDGER), proven by a real print 2026-10-26 |
| Print from the normal Print button on 11x17 (Ledger) paper as well as Letter: the print dialog offers only Letter and Ledger (no A4/A3 or other sizes); a Ledger job is sent with PAPER=LEDGER, and a printer that does not declare 11x17 holds the job with a plain reason | Built, testing. Not seen yet from a real Windows/Android print dialog; the printer side (PAPER=LEDGER) is proven by a booklet print |
| View a printed job's document: the person who sent it and the admins/approvers of the same organization can open the stored PDF from the job page ("View original file" and "View as sent to the printer"), until the retention window ends or the sender deletes it; a short-lived link is made on each click; no access across organizations and none for a platform super admin | Built, testing |
| Library: Daily study tab (early tools): today's (or any day's) Chumash with Rashi, Tanya, Hayom Yom, Rambam 3 chapters and Rambam 1 chapter, as a booklet whose pages are filled edge to edge (the fewest sheets that stay readable, largest font that fits). Hebrew on the left and English on the right, side by side with the verse number between and Rashi in a shaded box (or Hebrew only, or English only, chosen each time); Regular Letter or 11x17. Printio fetches a day once, from the Chitas & Rambam booklet page that Chabad.org pointed the owner to (chitas-site.vercel.app), and keeps it, so nobody uploads anything. Hebrew is set in Ezra SIL with every vowel and cantillation mark. Thank-you credit on the screen and at the end of every booklet. Not yet printed on a real device | Built, testing (needs migrations 0050 and 0051)
| Daily study booklet, second version: (1) a front page with the title and the date in Hebrew and English and a list of what is inside, one row per day, without page numbers (for example "Monday: Chumash with Rashi, Tanya, Hayom Yom, Rambam (1 perek)"; names follow the Language choice; only the studies really included); (2) several days in one booklet: a first and last day (up to 7), arranged By day or By study, with a "Skip days that are not available" tick box (off: it stops and names the days); (3) column widths when both languages are shown: Automatic measures each study's text and gives Hebrew 30 to 50% so English, usually longer, gets more room and the booklet needs fewer pages, or Even / Wider English / Much wider English; (4) font weights: uploaded files are grouped into families and each file's weight is read from the font file, so titles use the family's Bold, the text its Regular and Rashi its Regular, shown in a "Fonts" section where each can be changed (a one-weight family uses it for everything; bold is never faked); (5) a cleaner look: a thin rule under each study title, a small ornament under day headings, a lighter Rashi shade, and a footer with the date and page number | Built, testing. Rendered to PDF and looked at on screen with the bundled fonts and a stand-in multi-weight family; not looked at with the owner's real font families, not printed on a real printer. No migration |

### People and rules

| Feature | Status |
|---|---|
| Sign in with an emailed link; sign-in code box for a different browser | Built, testing |
| Sign in with Google (any Google account; it gives no access without an invite or an allowed domain). Off until the Google provider is enabled in Supabase, the Google consent screen is published, and NEXT_PUBLIC_GOOGLE_SIGNIN=1 is set at build time (until then the button is greyed "Coming soon"); privacy and terms pages | Built, testing. Not tried yet with a real Google account |
| Invite people with a link; the link carries the code through sign-in | Built, testing |
| Paste an invite link or code on the "you need an invite" page | Built, testing |
| Groups, page limits, approvals, who can print what | Proven |
| "Who can join": invite only, or invite plus allowed email domain | Built, testing |
| Activity log | Proven |
| Sender's code on every printed page and in the printer's job name | Built, testing |

### Devices and setup

| Feature | Status |
|---|---|
| A private address per device; any device can be switched off or deleted | Proven |
| Printer name per device: `Printio-<printer>-<user code>` | Built, testing |
| Step-by-step setup per device type, labelled when untested | Proven |
| "Test my connection" check in the add-device flow, result visible to admins | Built, testing |
| "Did it come out OK?" follow-up and per-setup status for admins | Built, testing |
| Banner showing which devices are confirmed | Proven |
| Install as an app (home screen) | Built, testing |

### Admin and server

| Feature | Status |
|---|---|
| Update this server: the page shows which code the print server is really running (and says 'restarted, but still running X' if it came back on old code); an update pressed while the server is offline shows as queued with a Cancel button, is not stacked twice, and expires after 7 days | Built, testing. Needs migration 0059 applied for the 'running code' part; not yet tried on the real server. |
| Help that works on every screen: a '?' next to page titles explains the page in plain words, a Help window (This page, Walkthrough, Glossary with search, Report a problem) that always covers the whole screen, and a step-by-step walkthrough that highlights the real buttons (starts only when someone asks) | Built, testing. Checked on sample screens at phone and desktop width; not yet used by real people. |
| Admin pages: people, printers and devices, rules and limits, reports, approvals, all jobs, settings | Proven |
| Live job list that refreshes by itself | Proven |
| Update the print server from the website, with live progress | Built, testing |
| Print agent and gateway run as Windows services that restart themselves | Proven |
| Weekly cleanup of old files | Proven |
| Whole-setup security review | Planned |

### Public website

| Feature | Status |
|---|---|
| Public home page, shown to everyone (signed-in people get an "Open Printio" button and an "About Printio" menu link) | Built, testing |
| Home page demo: pick a device and a finish, press Print; stapling and booklet folding-and-stitching are animated | Built, testing |
| Home page demo: optional synthesized sound (off by default) timed to the staple and fold | Built, testing, needs an ear-check |
| Home page: an 8 page booklet you can flip through, English and Hebrew (mirrored) | Built, testing |
| "I have an invite" box on /join: paste an invite link or code | Built, testing |
| Guided tour for new users | Switched off until it is rebuilt |

### Planned (see `docs/ROADMAP.md`)

Recorded 2026-11-15 in `docs/BACKLOG.md` (owner asks, not started): repeat one page many times per sheet; re-print a finished job with the same settings but different finishing; every staple option (audit of what is missing, then prove each on the printer).

Browse a library (Mafteiach first) and print from it; a booklet builder that combines
several texts with a cover and contents page; tap-to-pick pages; saved booklets; email alerts when a printer or the
server goes offline; printer status (jam, toner, paper); a test lab for printer settings; students and
Chromebooks with their own limits.

---

## 3. Share text (copy and paste)

**WhatsApp status, short**

> New project is up and running: Printio.
> Press Print on your phone or laptop and it comes out of the right printer. Windows, iPhone and Android all work.
> Real booklets, left or right binding, with each page as big as it can be. Invite only for now.

**WhatsApp status, with a few highlights**

> Printio is live (invite only for now).
>
> - Print from the normal Print button on Windows, iPhone and Android
> - Booklets that read the right way, left or right edge
> - Every page carries the sender's code, so nobody grabs the wrong pile
> - Rules, approvals and one link to invite your whole staff
>
> Want in? Message me.

**One line for a friend**

> I built a print system for schools: you press Print on any device and it comes out of the right printer, with proper booklets.

**Do not say** (not true yet): that Mac or Chromebook are confirmed, that it has paying customers, or that it is
available to the public.

---

## 4. How to keep this up to date

- New feature merged: add a row in section 2 with the right status, and add it to `FEATURE_ROWS` in
  `apps/web/lib/landing-content.ts` if visitors should see it.
- A device or feature proven on real hardware: change the status here, and the device list in
  `apps/web/lib/devices/confirmed.ts` for devices.
- A feature switched off or removed: say so here the same day.
