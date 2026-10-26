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
| Double-sided (long edge) and single-sided | Proven |
| Flip on the short edge from the print dialog | Built, testing |
| Staple top-left or top-right | Proven |
| Booklet, left binding and right binding | Proven |
| Booklet: pages scaled to fill, blank margins trimmed | Proven (on text documents) |
| Booklet: scans measured so each scan fills its cell | Built, testing |
| Booklet: no question about blank pages, an inline note instead | Built, testing |
| Booklet: preview that draws scanned pages | Built, testing |
| 11x17 booklet with Letter pages at full size | Built, testing |
| Duplicate protection (a repeat click within 30 seconds does not double print) | Proven |
| A jam or toner change does not fail a job; waiting-for-printer state | Built, testing |
| Share a PDF into Printio from the phone's share sheet (installed app) | Built, testing |
| Tap-to-pick pages: tap page thumbnails (with All / First page / Last 3 / Odd / Even / Swap / Clear) or type the range; both stay in step | Built, testing |
| Print from a link to a PDF (public link or Google Drive / Docs file), admins plus anyone with early tools on; fetched safely on the server and placed in the normal Print form | Built, testing |
| Booklet builder (admins, plus anyone an admin switches early tools on for): combine up to 12 PDFs or links into one booklet with a name, description, cover and contents page (Hebrew right-to-left supported), pick pages per file, reorder; then the normal Print screen takes over with the booklet switched on | Built, testing. Not tested yet on paper |
| Approvers' own jobs are approved automatically (a "deny" rule and quota limits still apply to them); disclosed on the job like the admin bypass | Built, testing |
| Early tools switch: an admin can turn the link import and the booklet builder on for one named person (Admin -> Users -> that person), so staff can help test; off by default | Built, testing |
| Booklet builder keeps your files while you visit the library to pick more and come back; after building, "Save a copy (PDF)" gives the normal page-by-page PDF (not the folded layout) to keep and upload again later | Built, testing |
| Library browser (early tools): browse Mafteiach's Likkutei Sichos by volume and parsha, maamarim and sichos by year, tap the files you want (Hebrew, translated, unedited, notes), then they go into the booklet builder with "Courtesy of Mafteiach (mafteiach.app)" on the contents page | Built, testing. Not tested yet on a real admin session; the Mafteiach team has not been asked |
| Library: search box, "English available only" filter and an "English available" badge (Mafteiach's translated files and English sections), plain "Hebrew sicha" / "English translation" button names | Built, testing. Not seen on a phone yet |

### People and rules

| Feature | Status |
|---|---|
| Sign in with an emailed link; sign-in code box for a different browser | Built, testing |
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

Browse a library (Mafteiach first) and print from it; a booklet builder that combines
several texts with a cover and contents page; tap-to-pick pages; saved booklets; email alerts when a printer or the
server goes offline; printer status (jam, toner, paper); a test lab for printer settings; Google sign-in; students and
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
