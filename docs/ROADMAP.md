# Printio roadmap: what is not done yet and how to do it well

Written 2026-10-25 from the owner's backlog and what the real devices showed. Order is my recommendation, highest value
first. "Needs you" means I cannot finish it without the owner at a device or a decision. Update this when things move.

## Next up

| # | What | Why it matters | How I would build it | Needs you |
|---|---|---|---|---|
| 1 | **Print from a link** (BUILT 2026-10-26, admins only, needs a real-world test) | The Mafteiach library and most shared files are links to PDFs. | Server fetches a public https PDF (or a Google Drive "anyone with the link" file) with strict safety limits (no internal addresses, size and time caps, must really be a PDF), then it flows into the normal Print form. Admin-only first. | Nothing, just a go |
| 2 | **Tap-to-pick pages** (BUILT 2026-10-26, on the Print form; the booklet builder will reuse it per source) | Typing page numbers is slow on a phone. | A thumbnail grid (tap to select, shortcuts for first page, last 3, odd, even) feeding the existing page-range field. Thumbnails drawn in the browser. | Nothing |
| 3 | **Booklet builder** (BUILT 2026-10-25, admins only, needs a real print test; saved booklets and library sources come later) | Combine several sichos or maamorim into one booklet with a name, a description, a cover and a contents page. | Several sources (upload, link, library), pages picked per source, reorder, generated cover and contents with a bundled Hebrew font, then the existing booklet code (left/right, 11x17). | Cover wording and language, credit line placement |
| 4 | **Library browser (Mafteiach first)** (BUILT 2026-10-26 for Likkutei Sichos, maamarim and sichos/farbrengens; early tools only; Sefer HaSichos and other sections not yet; needs a real-world test) | Print from the library without copying and downloading. | A connector that reads Mafteiach's entry pages (they are plain HTML with the Drive file links), caches metadata politely, shows what each entry offers (printed edition, unedited, hagahos), credits the library on the contents page. Admin first, then groups. | A word with the Mafteiach team before it goes beyond the in-house team |
| 5 | **Mac and Chromebook confirmed** | Two of five device types are still untested. | Walk each through the add-device flow; use the "Test my connection" result and gateway log to fix what breaks. | A Mac; the Chromebook that is already added |
| 6 | **Booklet quality on paper** | The sizing is measured but not seen printed. | Owner prints one scan booklet, one Word booklet and one 11x17 booklet; compare against the preview; adjust margins or the paper-size handling. | Printed samples |

## Reliability and trust

| What | How |
|---|---|
| Printer status (online, jam, toner, paper) | The agent probes the printer every poll and reports status; show it on printer cards and in "waiting for printer" messages. |
| Email alerts | When the agent, gateway or printer goes offline, email the admin. |
| Whole-setup security review | A read-only review of web app, gateway, update path, cron routes, tunnel and database rules, then fixes in priority order. |
| Server logs on the website | Rotate logs on the server and add a "Get recent logs" button for admins. |
| Backup download | A button that exports users, settings and rules. |

## Product polish

| What | How |
|---|---|
| Guided tour, rebuilt | One page at a time, highlighting the real button and waiting for the click; checked on every page at phone width before it is switched back on. |
| Short-edge flip on the website form | Add a "flip on the short edge" choice next to double-sided. |
| Saved booklets ("My booklets") | Save a booklet project to edit and re-print later. |
| Google sign-in | Diagnose the current failure; until then it is greyed out. |
| Students and Chromebooks | Their own limits and Google admin integration; needs its own design. |
| Test lab | Labelled test prints with a short code that maps to exact printer settings; the owner reports "worked" or "came out wrong" and the setting turns green for everyone. |

## Things I would not do

- Rotate landscape pages automatically in booklets (owner decision: only if someone clearly opts in).
- Claim a device or feature is working before it has printed on a real device.
- Offer the library to the public before the library's team has agreed in writing.
