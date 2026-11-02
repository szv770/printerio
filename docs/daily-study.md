# Daily study in the library (plan, 2026-11-01 - NOT BUILT, waiting for the owner's OK)

Goal: a "Daily study" part of the library with today's Chumash (with Rashi), Tanya, Rambam (1 chapter) and Rambam (3 chapters),
pulled from chabad.org (later more of its TorahTexts, and sie.org). The user picks items, then Printio prints them or builds a
Letter booklet whose pages are FULL (see section 3). Hebrew only / English only / both is chosen each time.

## Ground rules (decided with the owner)
- Sources are chabad.org and Sichos In English, not Sefaria. Both allow printing in yeshivos; the owner wants a thank-you shown.
- chabad.org and www.sie.org show a Cloudflare "Just a moment..." check to automated browsers. **We never get past it** (no masked
  browser, no solving, no proxy). Findings 2026-11-01: a plain headless browser stays on the check; a visible Chrome got the first page
  and Tanya, then was checked again on the next pages. So the fetch must be slow, rare and able to fail cleanly.
- shop.sie.org (the shop and its Library page) loads without a check. What its library really gives (text or only book pages) is not
  yet known.
- Not a mirror of their library: we save only what a day's study or a requested booklet needs. Never audio/video, the questions at
  the end, or the long footnotes.

## 1. Schedule: which portion is today's
- Read chabad.org's RSS feed (feed URL and whether it is behind the check: step 0 below). It says which portion/lesson/chapters apply
  to a date; it does not carry the text.
- Fallback if the feed is unavailable: the date-based page URLs (`dailystudy/tanya.asp?tdate=M/D/YYYY`, `torahreading.asp?tdate=`,
  `rambam.asp?rambamChapters=1|3`) tell us the title too.

## 2. Text: fetch once, keep it
- A small fetcher (Playwright driving the PC's own Chrome, visible window) opens at most ~5 pages a day, spaced by about a minute,
  reads only the main text blocks (Hebrew spans are marked `alternate_he`), drops footnotes, questions and media.
- Stored in a new table `library_daily_texts` (study, date, language, portion title, source URL, blocks as JSON, fetched_at).
  Own migration (next number 0050) with the explicit grant to `authenticated, service_role` and RLS read for signed-in members.
- If the check shows up: stop, record "blocked", retry later. An admin can press **Import from my browser** (they open the page
  themselves, pass the check as a person, and a bookmarklet/paste sends the text to Printio). Never automated past the check.
- Runs on the PC. Open question: Chrome needs an interactive desktop, but the services run as the limited `printio-svc` account
  (docs/SECURITY.md). Probably a scheduled task for the owner's login ("run only when logged on"). Needs the owner's yes.

## 3. "Fill the page" PDFs (the new renderer)
- Build the PDF from the stored text instead of scaling a finished PDF: choose margins, font size and line spacing so each page is
  full, then lay the pages into the existing Letter booklet (`lib/pdf/booklet-build.ts`, `padAndImposeBooklet`).
- Hebrew with the bundled David Libre fonts (`lib/booklet/fonts`), RTL via `lib/booklet/bidi.ts`. Both-languages mode: two columns or
  facing pages (choice on the form). Must keep Hebrew text byte-safe: the existing text-fidelity check (`lib/pdf/text-fidelity.ts`) applies.
- Each booklet gets a credit line: "Text courtesy of Chabad.org / Sichos In English, printed with permission. Thank you." (wording
  editable by the owner), plus a note in the library tab.

## 4. UI
- Library: new tab **Daily study** with the four items for today (and a date picker for other days), each with Hebrew/English
  choice; "Print this" and "Add to booklet" (cart items today are links to PDFs, so this needs a second cart item kind: stored text).
- Mobile first (375px), same Segmented/Chip components as the rest of the library.

## 5. Tests (written first, as always)
Parser against saved HTML fixtures (Tanya, Chumash, Rambam); schedule from a saved RSS fixture; layout fill (each page >= X% full, no
overflow, Hebrew text unchanged); store + grant migration; blocked-page handling (a fixture of the check page must produce "blocked",
never a retry loop).

## Phases
0. Look up the feed URL and robots rules; save fixtures. 1. Schema + parser + schedule. 2. Fetcher on the PC (+ blocked handling).
3. Fill-the-page renderer. 4. Library tab + credit. 5. Import-from-browser fallback. 6. More sources (TorahTexts, SIE) once 1-5 prove out.

## Open questions for the owner
- OK to run the fetcher as a scheduled task under the owner's PC login (needs a logged-in desktop)?
- Exact thank-you wording, and where it should show.
- What first for sie.org: the weekly sichos (already built) or the library?
