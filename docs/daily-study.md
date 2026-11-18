# Daily study in the library (plan 2026-11-01; phases 1-4 built 2026-11-02, untested on a real print)

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

## Decisions (owner, 2026-11-01) and step 0 findings
- Decided: fetcher runs as a scheduled task under the owner's PC login (installed only at phase 2, with short typed commands, after reading
  docs/SECURITY.md); thank-you wording as written above; after Daily study comes Shulchan Aruch via SIE's library (to be inspected), the
  weekly sichos already exist.
- robots.txt (read 2026-11-01): `Disallow: *dailystudy*mode*` (never use a `mode` parameter) and `Crawl-delay: 5` (our one-minute spacing
  is far inside it). Plain requests to the sitemap, article pages and guessed feed paths return 403 (the check), so the RSS feed URL could
  not be found automatically: **the owner gives the feed URL** (it is on chabad.org's RSS page). Until then the schedule falls back to
  the date-based page URLs.

## Status 2026-11-02
- Built and tested: RSS reader (`lib/library/daily/feed.ts`), page reader (`page.ts`), import check (`import.ts`), table 0050, actions (`app/(dashboard)/print/library/daily-actions.ts`), fill-the-page builder (`fill.ts`), library tab (`components/library/DailyStudyPanel.tsx`, preview at `/dev/preview?section=daily`).
- Finding: a Playwright-driven Chrome on the PC got the first page then Cloudflare's check on the next, even slowly. So the automatic fetch (plan section 2) is NOT built and not planned; "Import from my browser" is the way in. Chumash text has trop marks the bundled David Libre lacks: they are left out until a font with them (e.g. an OFL Noto Serif Hebrew) is bundled (needs the owner's OK to download).
- Not yet: print a real daily booklet and look at it; apply migration 0050 to Supabase before the website update; more sources (Hayom Yom, Tehillim, TorahTexts, SIE library / Shulchan Aruch).

## Status 2026-11-02 (later): new source, new layout
- Chabad.org's own pages sit behind a Cloudflare check we never get past, so the text now comes from the Chitas & Rambam builder (https://chitas-site.vercel.app) that Chabad.org pointed the owner to. One plain request per day (`/shiur?from=D&to=D&paper=half&...`), parsed by `lib/library/daily/source.ts`, saved in `library_daily_texts` (migration 0051 allows that source). The owner said one fetch is like a person loading the page and making a booklet. The page is HTML with no promised stability: if it changes, the reader returns nothing and the screen says the source looks different.
- The earlier route (a person saves Chabad.org's page and an admin uploads it: `import.ts`, `page.ts`'s `parseStudyPage`, `importDailyAction`) is still in the code but no screen uses it. Remove it if it is never needed.
- Layout follows that builder: Hebrew left, English right, verse/halacha number between, Rashi in a shaded box; one language alone uses the full width.
- The source shows no credit to Chabad.org on its pages; ask who runs it and confirm the credit wording.

## Status 2026-11-13: your own Hebrew fonts
- Owner wants better Hebrew than Ezra SIL (SBL Hebrew, or fonts they upload). SBL Hebrew's licence stops us bundling it, so fonts are **uploaded in the app**: Admin -> Fonts (org admins; migration 0052 `org_fonts`, private bucket `org-fonts`, service-role only; `lib/booklet/custom-font.ts` checks a file, `org-fonts.ts` lists them). Members pick one in a "Hebrew font" list on the Daily study form and on the booklet builder (cover, contents, back page); the choice is remembered per browser. Default stays Ezra SIL.
- Drawn only, never changed: if a font lacks vowels or trop the text uses, the form says so before printing (`missingMarks`); the fidelity check still applies.
- Found with the owner's real fonts (OT Siddur/Sid/Heilig/Vilna/Holtz/Talmudis): `.otf` fonts with CFF outlines turn into empty boxes when shrunk to a subset by pdf-lib, so they are embedded whole (`embedHebrewFont`); `.ttf` fonts are still subset. Holtz/Vilna are variable fonts (the default instance is drawn). These fonts have no Latin letters (digits and punctuation are fine), so they are for Hebrew text only.
- Owner's view: Vilna or Siddur for body text; Talmudis and Holtz only for titles/headers. A separate **title font** is not built yet (titles are English today).
- Not yet: printed on paper; the title font; SBL Hebrew itself (not yet seen).

## Status 2026-11-15: title font, English fonts, Hebrew titles
- Owner's decisions: (1) a separate **title font** for Hebrew titles (heavy display fonts such as OT Talmudis or OT Holtz), body in OT Siddur, Vilna or SBL; (2) Hebrew titles follow the **Language** choice; (3) English text can be set in other fonts: a few bundled open fonts and the owner's own uploaded English fonts. Their Hebrew fonts have no Latin letters, so English is its own choice.
- Uploads: migration 0053 adds `has_hebrew` (default true, so existing fonts stay Hebrew fonts) and `has_latin` to `org_fonts`. `inspectFont` accepts a font with all 22 Hebrew letters or all 52 English letters (A-Z, a-z) and rejects one with neither ("This font has neither Hebrew nor English letters"). Admin -> Fonts shows a Hebrew / English badge per font. Note: the bundled Ezra SIL and David Libre both cover Hebrew and English letters.
- Forms: the Daily study form has "Hebrew font", "Title font" (first option "Same as the Hebrew font") and "English font" (bundled first, then uploaded English fonts); each is remembered per browser (`printio.daily.hebrewFont`, `.titleFont`, `.latinFont`). The booklet builder has the same three. The server checks every choice again (own organization only, Hebrew fonts must have Hebrew, the English font must have English letters; `loadFontChoices` in `lib/booklet/custom-font.ts`).
- Hebrew titles (`lib/library/daily/titles-he.ts`): study names, the Hebrew date (Intl Hebrew calendar in UTC, flips at midnight, not sunset) and, for the Chumash only, "פרשת ..." from the source's portion line. Only "Chayei Sarah" and "Vayera" have been seen in the real source text; the other 52 spellings are the usual Hebcal and Chabad spellings and are unverified against the source. An unknown name gives no portion, so the title is just "חומש".
- Not yet: any of this printed on paper or looked at with the owner's real fonts; the English fonts on the real printer; migration 0053 applied to Supabase.

## Status 2026-11-15 (C1d): the week ahead comes from the owner's print server
- With the website switch `LIBRARY_VIA_SERVER=1` the website no longer fetches daily text live (no request to the source, no rate limit use): `ensureDay` only reads `library_daily_texts`, and a day that is not saved answers "That day has not been saved yet. Your print server saves the next week every night; try again later." (or says no print server is online). The owner's print server (agent switch `PRINTIO_LIBRARY_WORKER=1`) saves today and the next 6 days at about 03:30 local time and about 2 minutes after it starts, insert-only (a day someone already saved is never overwritten). With the switch OFF nothing changed: the website still fetches a missing day itself on first use. See `docs/PHASE-C-PLAN.md` (C1d) for the go-live order.

## Status 2026-11-16: booklet v2 (font weights, column widths, front page, several days)
Owner's five asks, all built, none printed on paper yet. No migration, no new dependency.
- **Font weights.** Each uploaded file is still its own entry in Admin -> Fonts; the form now offers **families**. `lib/booklet/font-families.ts` (pure) groups files and picks one per job: titles and headings the weight nearest 700, body nearest 400, Rashi nearest 400 (Regular, not Light: at Rashi's smaller size Light prints thin; change it in the form if wanted). A one-weight family uses that file for everything; with no bold the nearest weight is used; bold is never faked. The weight is read from the file itself (OS/2 usWeightClass, family from the name table: `font-facts-read.ts`) when the form asks for the font list (`org-font-facts.ts`: each file is read once per running server and remembered; nothing is stored, so **no migration**). If a file cannot be fetched or read, or says 400 while its style name says Bold/Light, the name decides ("OT Sid Daled Bold" = 700). The form's collapsed "Fonts" section shows Titles / Body text / Rashi for Hebrew and English with a list to change each (`font-roles.ts`); a heavy display font from another family can still be chosen for titles. The server takes one id per job (`rashiFontId`, `latinTitleFontId`, `latinRashiFontId` next to the old three; `loadRoleFonts` in `custom-font.ts`, same own-organization and has-Hebrew / has-English checks). Bundled fonts behave as before (a bundled English family: Regular for text and Rashi, Bold for titles).
- **Column widths** (both languages only). Form: Automatic (default), Even 50/50, Wider English 40/60, Much wider English 33/67. Automatic (`chooseHebrewShare` in `fill.ts`) works per study: it counts the lines each column would need at every Hebrew share from 50% down to 30% and keeps the shortest (the share nearest 50/50 among those within 1% of the best, so Hebrew is not squeezed for nothing). Rashi's box uses the same split. One language keeps the full width. `buildFilledPdf` without `columns` is still even.
- **Look.** Type scale in one place (`SCALE`): day/study heading 1.32, study title 1.15 with a thin rule under it, section heading 1.02, body 1, Rashi 0.9 in a lighter shade, verse number 0.8, credit 0.75. Day (or study) headings are centred with a short rule and a small diamond. Footer on every page of text: thin rule, the page's date (English at the inner edge, Hebrew in the middle; Hebrew only for a Hebrew booklet) and the page number at the outer edge (a Hebrew booklet binds on the right). A heading is kept with the headings and first two lines after it; only short rows are kept whole (long ones split across pages, so no big gaps). Fill-the-page, the multiple of 4 and the credit at the end are unchanged; the front page counts as page 1.
- **Front page** (`cover` in `FillInput`): thin double frame, title (Hebrew large, English beneath, by Language), ornament, date in Hebrew and English, then "In this booklet / בחוברת זו" with one row per day ("Monday: Chumash with Rashi, Tanya, Hayom Yom, Rambam (1 perek)"), no page numbers; the list shrinks to fit a full week and never breaks inside an entry. Short names: `CONTENTS_LABELS` (studies.ts) and `CONTENTS_LABELS_HE`, `hebrewWeekday` (titles-he.ts).
- **Several days.** Form: first day + "Until" (up to 7 days), "Arrange: By day | By study", "Skip days that are not available" (off by default). `lib/library/daily/merge.ts` (pure) orders the items and writes the contents list to match: by study the rows read "Chumash with Rashi: Monday, Tuesday". Each day still goes through `ensureDay` unchanged (shared saved text first; `LIBRARY_VIA_SERVER` on: saved text only; off: the per-person limit of 12 days per 10 minutes, then one request). Extra care for several days: fetches are spaced 1.2 s apart, and after the source fails once it is not asked again in that booklet (later days are used only if already saved). Unavailable days stop the booklet with "Not available: Tuesday, November 3, 2026; ... Tick "Skip days that are not available" ..."; with the tick they are left out and the form says which before going on. A study missing from one day is named the same way.
- Also fixed: a non-breaking hyphen in the English ("G‑d") showed as an empty box; it is drawn as a plain hyphen (English only; Hebrew is never touched).
- Checked: sample booklets rendered with the real code and looked at page by page (front page, Hebrew + English with Rashi, Hebrew only, two days by day, two days by study in English, a full week, and a stand-in multi-weight family: DejaVu Sans Regular/Bold for Hebrew, Inter Regular/Bold/Light .otf for English). The merged booklets pass the padding and Hebrew text-fidelity check (`merge.test.ts`).
- Not yet: printed on paper; looked at with the owner's real font families (their OS/2 weights are unknown: check the "Fonts" section shows the right Bold); Admin -> Fonts still lists files one by one (no family grouping there); the booklet builder (cover/contents of mixed booklets) does not use weights yet; the form's several-days and Fonts states were not screenshotted (only the default state at 375 px).

