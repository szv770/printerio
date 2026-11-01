# Kyocera raw print experiment

Goal: find out whether the Agent can send jobs **straight to the printer's raw port (9100)**,
bypassing the Windows queue (and the one-queue-per-finishing-profile limit) and SumatraPDF. This
is a separate track from the print-dialog feature in [ipp-printing.md](./ipp-printing.md) - nothing
there depends on it. Status: capture, decode and **replay all confirmed working on the real printer (2026-10-18)**; PDF-direct also works, left-binding booklet solved (2026-10-19). Owner decision: raw port is the intended main path, Windows queues only a single fallback (see ipp-printing.md "Direction update").

## How the capture was made

Add a second printer with the same Kyocera KX driver, give it a **Local Port named
`C:\Temp\kyo.prn`** (Properties > Ports > Add Port > Local Port > New Port). Printing writes the
exact byte stream the driver would send. (A `FILE:` port fails from modern apps like Chrome/Edge:
no "save as" box appears.) Copy the file after each job; each print overwrites it. To read a file:

```powershell
[Text.Encoding]::ASCII.GetString((Get-Content C:\Temp\job.prn -Encoding Byte -TotalCount 3000)) -replace '[^\x20-\x7E\r\n]','.'
# paste-able copy of a small file:
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\Temp\job.prn'))
```

## What the driver sends (Kyocera TASKalfa MZ8500i, KX driver)

A readable **PJL header**, `@PJL ENTER LANGUAGE=PCLXL`, then binary **PCL XL** page data
(the job also embeds fonts), ending with `@PJL EOJ`.

| Setting | Where | Value seen |
|---|---|---|
| Staple, top-left (long-edge duplex) | PJL header | `OUTBIN=OPTIONFACEDOWN`, `STAPLEOPTION=ONE`, `FINISH=STAPLE` |
| Staple, top-right | PJL header | `KFEEDEDGE=LONGEDGE`, `OUTBIN=OPTIONFACEDOWN`, `STAPLEOPTION=ONEOPPOSED`, `FINISH=STAPLE` |
| One-sided | PCL XL, page setup | attribute `SimplexPageMode` (0x34) |
| Duplex | PCL XL, page setup | attribute `DuplexPageMode` (0x35): **0 = short edge, 1 = long edge** |
| Color / mono | PJL header | `KCOLORMODE=COLOR` / `MONO` (also `COLORMODE` in a comment) |
| Booklet (layout only) | header + PCL XL | `KPAGESPERSHEET=2`, comment `NUP 2`, PCL XL `Orientation=1` (landscape), duplex long edge; the driver reorders the pages itself |

The `INFO: ... DUPLEX ON/OFF` PJL comment is informational only. Duplex values were confirmed by
decoding the binary of three captures (they differ only in these bytes). Copies are `QTY` in the
header (so far only seen as 1).

## Replay results (2026-10-18, real MZ8500i, raw port 9100 reachable from the laptop)

Captured files sent unchanged with a 5-line PowerShell TcpClient snippet (`send-raw.ps1` wraps it):

| Job | What came out |
|---|---|
| 1 sheet, duplex long edge, staple | 1 sheet, no staple (nothing to staple with 1 sheet; expected) |
| 6 pages (3 sheets), duplex, `STAPLEOPTION=ONE` | stapled top-left, double-sided: **works** |
| 8 pages pre-imposed booklet, `KBOOKLET` + `KREVERSEFOLD` | folded, saddle-stitched, right binding: **works** |

Confirmed PJL for finishing (all plain text before `@PJL ENTER LANGUAGE=PCLXL`):

- Staple top-left: `OUTBIN=OPTIONFACEDOWN`, `STAPLEOPTION=ONE`, `FINISH=STAPLE` (Acrobat's job also had `KFEEDEDGE=LONGEDGE`).
- Staple top-right: `KFEEDEDGE=LONGEDGE`, `OUTBIN=OPTIONFACEDOWN`, `STAPLEOPTION=ONEOPPOSED`, `FINISH=STAPLE`.
- Saddle-stitch booklet, right binding: `OUTBIN=KBOOKLET`, `FINISH=KREVERSEFOLD`. The driver was set to
  "create booklet from application", i.e. the app imposed the pages itself (the printer only folds and
  stitches) - exactly what `apps/web/lib/pdf/imposition.ts` already produces. Left binding value not yet captured.
- Duplex is still the PCL XL `DuplexPageMode` attribute, not PJL, in driver output.

## PDF-direct results (2026-10-18): a plain PDF + hand-written PJL header WORKS

`Send-Pdf` (tools/raw-print/send-pdf.ps1): UEL, `@PJL`, `@PJL JOB NAME=...`, `@PJL SET ...` lines,
`@PJL ENTER LANGUAGE=PDF`, raw PDF bytes, `@PJL EOJ`, UEL, sent to 192.168.100.168:9100. No PCL XL
conversion needed. Results with a 6-page PDF:

| Header | Result |
|---|---|
| none (no SET lines) | printed whole doc, one-sided |
| `DUPLEX=ON`, `BINDING=LONGEDGE`, `OUTBIN=OPTIONFACEDOWN`, `STAPLEOPTION=ONE`, `FINISH=STAPLE` | double-sided long edge, stapled **top-right** (the driver's PCL XL job with the same STAPLEOPTION gave top-LEFT, so staple position depends on more than this value: page orientation / `KFEEDEDGE` / binding; mapping unfinished) |
| pre-imposed booklet PDF + `DUPLEX=ON`, `OUTBIN=KBOOKLET`, `FINISH=KREVERSEFOLD` | folded and stitched but **backwards** (fold/staple on the wrong side). Likely that PDF was imposed for left binding while `KREVERSEFOLD` is the right-binding fold; the driver-replay job that worked was a right-binding (Hebrew) doc. Left-binding value not yet known. |

Standard PJL `DUPLEX` / `BINDING` work for duplex. Untested: copies (`QTY`), paper size/tray, color.

## Staple position map

SUPERSEDED: an earlier table here (from a different 6-page PDF) said `ONE` = top-right. That was wrong for the portrait test
documents. The confirmed map is under "Right binding solved, staple map corrected" below: `ONE` = top-left,
`ONE` + `KFEEDEDGE=SHORTEDGE` = top-right, `ONEOPPOSED` = bottom-left (portrait, duplex long edge). **Simplex verified (Q1, Q2, 2026-10-20):** one-sided `ONE` = top-left, one-sided `ONE` + `KFEEDEDGE=SHORTEDGE` = top-right, same as duplex. Not yet verified: landscape pages.

## Booklet: PDF-direct came out in the wrong page order (unresolved)

Same document through two paths, same PJL (`KBOOKLET` + `KREVERSEFOLD`, left- and right-binding driver
captures both emit exactly these; binding side is not in the PJL, it comes from how the app imposed the pages):
- driver PCL XL replay: correct saddle-stitched booklet.
- plain PDF + hand-made header: wrong order (owner: first page position shows page 5, second shows 6, then two blanks, then page 1).
Hypotheses: PDF engine auto-rotates/places landscape pages differently from the driver's PCL XL;
sheet/page delivery order; missing orientation/binding PJL. Plan B: convert PDF to PCL XL with Ghostscript
and prepend the driver's header. Next: replay the fresh driver capture of the same PDF as a control, record the
PDF's page size/count, and get a per-sheet description or photo of the wrong output.

## Booklet captures jobH vs jobL decoded (2026-10-18)

Compared the two app-imposed booklet captures byte-for-byte and by PCL XL structure (`tools/raw-print/pxl.js`, no deps):
- PJL identical apart from the job-name timestamp: **both use `OUTBIN=KBOOKLET` + `FINISH=KREVERSEFOLD`**. So `KREVERSEFOLD` is
  NOT "the right-binding fold"; left vs right binding is not in the PJL at all. (Earlier hypothesis removed; "left-binding value unknown" is answered.)
- PCL XL identical in structure: 4 sides, Letter (`MediaSize=106`), `Orientation=0` (portrait), **`DuplexPageMode=0` = short edge**.
- The only difference: every Y coordinate on every side moves by exactly +/-3200 dots (= the two halves of each sheet swapped, no mirroring).
  This is what `mirroredIfNeeded` in `imposition.ts` does.
- `/c/Temp/booklet.pdf` and `booklet_left.pdf` are the same shape: 4 portrait 612x792 pages, each holding two 90-degree-rotated pages stacked
  top/bottom (halves at y~29 vs y~425). The earlier "KPAGESPERSHEET=2, Orientation=1, long edge" booklet capture was driver-imposed; these are app-imposed, so no contradiction.
- Likely cause of the backwards PDF-direct booklet: driver booklets flip on the **short edge**; the PDF-direct header had `DUPLEX=ON` and no
  `BINDING`, so it defaulted to long edge, which turns the back sides upside down. **Next test: same PDF + `BINDING=SHORTEDGE`** (see below); if it still fails, replay `jobH.prn` unchanged as control.

## Booklet PDF-direct tests (2026-10-18/19, numbered 1-8 file, imposed with imposeBookletPdf, portrait sheets, `DUPLEX=ON`, `BINDING=SHORTEDGE`, `OUTBIN=KBOOKLET`)

| Job | Layout | Sheet order | FINISH | Result |
|---|---|---|---|---|
| D1 | left | normal | none, no booklet | correct plain duplex short edge; hand-folds into a perfect LTR booklet (PDF is right) |
| D2 | left | normal | `KREVERSEFOLD` | right page order but inside out (spine/staples on wrong side) |
| E1 | left | normal | **`KFOLD`** | **PERFECT left-to-right saddle-stitch booklet** |
| E2 | left | reversed | `KREVERSEFOLD` | pairs swapped (2,1,4,3,6,5) |
| E3 | right (mirrored) | normal | `KREVERSEFOLD` | nesting wrong (1 and 8 in the middle) |
| A1-A3 | various | | `KREVERSEFOLD` | scrambled, see git history/notes |

So for PDF-direct: **left binding = `OUTBIN=KBOOKLET`, `FINISH=KFOLD`, `DUPLEX=ON`, `BINDING=SHORTEDGE`**, pages imposed by the app (left layout, normal sheet order). Right binding still open.

### Right binding solved, staple map corrected (2026-10-19)

- **F1 (right/mirrored layout, normal sheet order, `KFOLD`, `BINDING=SHORTEDGE`) = perfect right-to-left booklet.** Same printer setting as
  left binding; the imposition layout carries the side. F2 (reversed sheet order) was wrong. `KREVERSEFOLD` is never needed.
- **Staple, portrait test.pdf / num8.pdf, duplex long edge:** `ONE` = top-left, `ONEOPPOSED` = bottom-left; `KFEEDEDGE=LONGEDGE` changes nothing.
  This supersedes the older table above (that run was on a different PDF and put `ONE` at top-right). **Top-right = `ONE` + `KFEEDEDGE=SHORTEDGE`** (job P1, confirmed). `ONEOPPOSED` + `KFEEDEDGE=SHORTEDGE` (P2) and `BINDING=SHORTEDGE` + `ONE` (P3) both gave top-left. Copies via `QTY` work (2 copies confirmed).
- Test tools: `tools/raw-print/send-labelled.mjs` (stamps a label on page 1; always label prints), `send-built.mjs`, `make-booklet-test.mjs`, `pxl.js`.

## Open mapping work

1. Staple: try `STAPLEOPTION=ONEOPPOSED`, and `ONE` with `KFEEDEDGE=LONGEDGE` (Acrobat's job had it); record where each lands relative to the upright page and the PDF's orientation.
2. Booklet: (left-binding `FINISH=` answered: same as right, see above) confirm which of booklet.pdf / booklet_left.pdf is which with `BINDING=SHORTEDGE`.

## Next: does the printer accept a plain PDF with a hand-made PJL header?

Replay only proves the printer obeys the PJL when it is given the captured PCL XL page data. To print
arbitrary PDFs we need either (a) PDF direct (try below), or (b) PDF -> PCL XL conversion (Ghostscript
`pxlmono`/`pxlcolor`) plus our PJL header. Test (a) with `tools/raw-print/send-pdf.ps1`; standard PJL
`DUPLEX=ON` / `BINDING=LONGEDGE` may replace the PCL XL duplex attribute. Try with and without
`-NoEnterLanguage`. Untested.

## Still unknown

- **Left-binding saddle stitch**: only right binding (`KREVERSEFOLD`) is captured; left binding value unknown.
- Other staple positions / two staples / punch (`STAPLEOPTION` other values), copies > 1, paper size
  codes (`MediaSize=106` for Letter in the PCL XL), paper tray.
- Whether the printer accepts **PDF directly** on 9100 (maybe with a PJL header), or whether we must
  produce PCL XL (e.g. Ghostscript `pxlmono`/`pxlcolor`) and prepend our own PJL header.
- Which port/protocol the real queue uses (Printer Properties > Ports); is 9100 reachable from the
  Agent PC?

## Next experiments, in order (each is cheap and safe: one small job)

1. **Replay**: send a captured file unchanged. Expect one stapled page, no Windows queue involved.
   ```powershell
   .\tools\raw-print\send-raw.ps1 -PrinterIp <printer-ip> -File C:\Temp\jobD.prn
   ```
   (Scripts are optional: the core is a 5-line TcpClient snippet inside `send-raw.ps1`.)
2. **Tweak the header**: change a setting in the text header only and confirm the printer obeys, e.g.
   staple top-left -> top-right. `-DryRun` writes the edited file without sending.
   ```powershell
   .\tools\raw-print\send-raw.ps1 -PrinterIp <ip> -File C:\Temp\jobD.prn -Replace @{ 'STAPLEOPTION=ONE' = 'STAPLEOPTION=ONEOPPOSED' }
   ```
3. Send the PJL header + a small PDF and see whether the printer prints it.
4. Only if 1-3 work: design the Agent change (send raw, lose Windows spooler status, so keep SNMP /
   other status in mind). Risks: no spooler job status, driver-specific bytes, cannot be validated
   without the physical printer.

## 11x17 (ledger) paper: proven 2026-10-26

Three numbered test prints of the same 11x17-imposed 4-page booklet (labelled sheets, sent with tools/raw-print/send-labelled.mjs):
1. `DUPLEX=ON BINDING=SHORTEDGE OUTBIN=KBOOKLET FINISH=KFOLD` only: printed on LETTER, shrunk (the printer's default paper; this is the old behaviour).
2. The same plus **`PAPER=LEDGER`**: a proper ledger booklet. **This is the setting.**
3. `DUPLEX=ON BINDING=SHORTEDGE PAPER=LEDGER` (no fold/booklet tray): plain ledger, short-edge duplex.
So an 11x17 booklet (print_jobs.paper_size = "tabloid") now sends `PAPER=LEDGER` right after the booklet settings (packages/shared/src/pjl.ts, `paper: "ledger"`).


## What the printer says it supports (asked over port 9100, 2026-11-01)

A read-only query (`@PJL INFO CONFIG`, `@PJL INFO VARIABLES`, sent with no job, nothing printed) returned the printer's own description. This is what it reports; **nothing below counts as proven until a labelled print shows it works.**

- **Paper input trays** (PJL INFO CONFIG): BYPASS (Letter, CARDSTOCK default, 250 sheets), TRAY1 (Letter, plain, 550), TRAY2 (Ledger, plain, 550), TRAY3 (Letter, plain, 1500), TRAY4 (Letter, plain, 1500). The only tray-related settable variables are read-only (`INTRAYnSIZE`); there is no `MEDIASOURCE` variable in the list, so tray choice is probably made by the printer from `PAPER` + `MEDIATYPE` (to confirm).
- **`PAPER=`** accepts (39): MONARCH, COM10, DL, C5, EXECUTIVE, LETTER, LEGAL, A4, B5, A3, B4, LEDGER, A5, A6, B6, COM9, COM6, ISOB5, CUSTOM, C4, JPOST, JPOSTD, OFICIO2, FB12X18, ROC8K, ROC16K, MO216X340, P13X19, SRA3, KAKUGATA2, NAGAGATA3, YOUNAGA3, NAGAGATA4, P13X19.2, STATEMENT, FOLIO, YOUKEI2, YOUKEI4, LSIZE. (Only LEDGER is proven.)
- **`MEDIATYPE=`** accepts (28): AUTO, PLAIN, TRANSPARENCY, PREPRINTED, LABELS, BOND, RECYCLED, VELLUM, ROUGH, LETTERHEAD, COLOR, PREPUNCHED, ENVELOPE, CARDSTOCK, COATED, THICK, FINE, INDEXTABS, CUSTOM1..CUSTOM8, THINPAPER, NONE.
- **`OUTBIN=`** accepts (16): KJOBSEPARATOR2FACEDOWN, OPTIONFACEDOWN, KOPTIONSUBFACEDOWN, KTRAY1FACEDOWN/FACEUP ... KTRAY5FACEDOWN/FACEUP, KOPTIONSUB2FACEDOWN, KLEFTTRAYFACEUP, KBOOKLET. The out-tray list in INFO CONFIG also shows the finisher's BOOKLET tray. (OPTIONFACEDOWN and KBOOKLET are proven.)
- **`FINISH=`** accepts: NONE, STAPLE, ON, **KPUNCH**, **KPNCHANDSTPL**, KFOLD, KREVERSEFOLD (do not use; it scrambles pages).
- **`STAPLEOPTION=`** accepts: DEFAULT, ONE, **TWO** (dual staple), ONEOPPOSED.
- **Punch unit exists**: MAIN 3 holes (US), SUB 2 holes (US).
- Also settable: `DUPLEX`, `BINDING` (LONGEDGE/SHORTEDGE), `QTY` (1-9999), `ECOPRINT`, `JOBOFFSET`, `HOLD` (OFF/ON/STORE/PROOF/KUSERBOX), `HOLDTYPE`, `ORIENTATION`, `RESOLUTION`.
- Job messages: `@PJL USTATUS` types DEVICE, JOB, PAGE, TIMED are supported (see docs/ROADMAP.md for what a probe showed).
- The script that asked: send `<ESC>%-12345X@PJL` + `@PJL INFO VARIABLES` + `<ESC>%-12345X` to port 9100 and read for a few seconds (the printer may be asleep, status 35078 "Sleeping...", and answers anyway).

Labelled tests sent 2026-11-01 (results to be recorded here): T1 `STAPLEOPTION=TWO FINISH=STAPLE` (dual staple), T2 `FINISH=KPUNCH` (punch), T3 `MEDIATYPE=PLAIN`.

## Printer feedback in the Agent (polling design, built 2026-11-01, untested on the real agent)

What the Agent does when `PRINTIO_PRINTER_FEEDBACK=true` (default **off**; with it off the bytes and behaviour are exactly as before).

**Why not listen on the job's own connection (tried first, abandoned).** Measured on the real printer: while we stay connected the printer reports only the first pages of a multi-copy job (PAGE 1..4 of 8) and withholds the rest, and the messages it has queued **leak onto the next connection**: job B's connection received job A's PAGE 5..8 and the parser said "confirmed 6 of 5". Also the printer **remembers** `USTATUS` settings (PAGE=ON, TIMED, VERBOSE stay set), so every later connection got stray messages. So no PAGE/TIMED/VERBOSE setting is used any more and nothing is listened for on the job connection.

**Measured, reliable behaviour.** Send the job exactly like the normal path (data, then FIN; the printer closes at once). Then open a fresh short connection every 3 s, write `<UEL>@PJL` + `@PJL INFO STATUS` + `<UEL>` and read about 1.5 s. Polls at +3..+15 s returned nothing. The first poll after the job finished (+18 s) returned, in one reply: `@PJL USTATUS PAGE` 7, `PAGE` 8, `@PJL USTATUS JOB / END / NAME="EXPC mvy3xdvv" / PAGES=8` and `@PJL USTATUS DEVICE / CODE=10001 / DISPLAY="Ready."`. The job NAME matched ours and **PAGES=8 = pages printed**. `JOB` and `DEVICE` messages are on by default on this printer, so no setting is needed.

**PAGE counts pages (printed sides), not sheets.** 4-page duplex x 2 copies = 8; a 5-page duplex job reported PAGES=5 (the blank back is not counted). Expected pages come from the web app (`printRequest.expectedPages`: copies x pages, booklets count the imposed sides); an older server that sends none = feedback is skipped.

**What the Agent does**
- Header: `@PJL USTATUS JOB=ON` and `DEVICE=ON` (the printer's defaults) only (`packages/shared/src/pjl.ts`, `ustatus: true`).
- Unique job name: the PJL job name is `<title> <token>` (token = first 8 letters/digits of the job id; `uniquePjlJobName`, 60 chars max, the token survives a long title), so the same title printed twice is never confusable.
- Polling (`pollPrinterVerdict`, `apps/agent/src/raw-print-executor.ts`): every ~3 s a short connection, query above, read ~1.5 s, destroy. Everything received goes to the parser (`UstatusFeedback` in named mode, `packages/shared/src/pjl-ustatus.ts`), which keeps unfinished messages between polls and understands several messages per read and the `INFO STATUS` answer. A refused or failed poll is just skipped.
- Only the `JOB END` with **our unique name** counts (other names, and all PAGE messages, are leftovers and ignored). PAGES >= expected: completed with "Printer confirmed N of N pages". END with fewer pages: not confirmed, reported `failed` (needs a person, never re-sent) with "The printer finished the job but reported only X of Y pages" (it may have been cancelled at the panel).
- A DEVICE message or INFO STATUS code outside 10xxx and other than 35078 "Sleeping..." is attention: logged, polling continues to the cap, then the job is reported `failed` with the printer's own words (`[printio:printer-error v1 ...]`). 10023 "Processing..." is also the normal PJL state for a long time after a job: never a problem and never "done". Only our JOB END is done.
- Cap: 60 s + 1.5 s per page (never more than 30 minutes, and never past the job's lease minus 60 s; under 30 s of lease to spare = no feedback). After the cap with nothing seen: completed as before with "Sent to the printer; it did not confirm each page" (counts as sent, not a failure).
- The Agent's own status probe (health monitor, `isSending` guard) stays off the printer from the moment the job is sent until the verdict (`holdSending` in `send-activity.ts`): it would swallow our JOB END. The same printer's next job is not claimed while a job is being confirmed.
- Tests: fake printer implementing the measured behaviour (`apps/agent/test/raw-print-feedback.test.ts`), orchestrator wiring (`orchestrator-release.test.ts`), probe guard (`health-monitor-printers.test.ts`).
- Not done: live per-sheet job events (event types are a database check constraint), the gateway wording for the attention failure. Not yet run end to end through the real Agent.

### Correction after more live tests (2026-11-01): the page counter is the dependable signal

Checking every 10 s for the job's `JOB END` message usually MISSES it: the printer pushes that message only to a connection that is open at that moment (it is not queued for the next connection), and holding a connection open for the whole job would stall other people's jobs on this shared printer. What works at any time on a short connection is `@PJL INFO PAGECOUNT` (the printer's total pages printed). The agent now reads it once before sending (`countBaseline`), then checks `INFO STATUS` + `INFO PAGECOUNT` on one short connection (first check about 10 s + 0.5 s per page after sending, then every 10 s, easing to 20 s) and confirms when the counter has risen by at least the expected pages ("the printer's page counter rose by N"). Measured: a 4-page duplex job with 2 copies (8 pages) confirmed in about 30 s with 3 short connections; a 1-page job showed +1 after 13 s. Limits: someone else printing at the same moment can inflate the counter (it can only look further along; it still needs the expected number), and a booklet's expected count (imposed pages x copies) is not yet measured. If the JOB END message for our unique job name happens to be caught it still counts. Each short connection may show as an entry in the printer's own job log, which is why checks are few.

## Labelled tests 2026-11-01 (results)

| Test | Settings sent | What came out |
|---|---|---|
| T1B | `DUPLEX=OFF OUTBIN=OPTIONFACEDOWN STAPLEOPTION=TWO FINISH=STAPLE` (2 single-sided sheets) | **Two staples on the left edge. Proven (portrait).** (T1, the same with `DUPLEX=ON` and only 2 pages = one sheet, was not stapled: a printer cannot staple one sheet.) |
| T2 | `DUPLEX=OFF OUTBIN=OPTIONFACEDOWN FINISH=KPUNCH` | **3 holes punched on both pages. Proven** (main punch unit, US 3-hole). |
| T3 | `DUPLEX=OFF MEDIATYPE=PLAIN` | Printed normally, single sided. **Proven** (paper type is accepted; which tray it picks was not tested). |

**Used by Printio (2026-11-01):** T1B (two staples, left) and T2 (3-hole punch) are wired into `packages/shared/src/pjl.ts` as `staple: "dual-left"` and `punch: true`, delivered only for the combinations listed in `PROVEN_FINISHING_COMBOS` (single-sided portrait are `proven: true`; double-sided long-edge punch (P1) and punch + top-left staple single-sided (`KPNCHANDSTPL`, P2) were proven by labelled prints on 2026-11-01 and are `proven: true`; double-sided two staples (P3) did NOT work, the printer made one top-left staple instead of two on the left, so it stays `proven: false` and is held with "not tested on this printer yet"). Stored on the job as `finishing.stapleStyle = "dual-left"` / `finishing.punch = true`; Agent 0.2.1 or newer is required (older Agents are refused for such jobs). Print dialog: finishings 28 and 5/78 (advertised). Not yet run through the real dialog/agent.

## What the printer sends back on port 9100 (measured 2026-11-01)

Setting `@PJL USTATUS DEVICE=VERBOSE`, `JOB=ON`, `PAGE=ON` (and optionally `TIMED=5`) before the job, and keeping our side of the connection OPEN:
- `@PJL USTATUS JOB / START / NAME="<job name>"` right after the job starts. **There is no END message.**
- `@PJL USTATUS PAGE / <n>` once per finished **sheet** (a 4-page double-sided job with 2 copies sent 1,2,3,4: it counts sheets, not sides). They can arrive several in one TCP chunk.
- `@PJL USTATUS DEVICE / CODE=10001 DISPLAY="Ready." ONLINE=TRUE` and `CODE=10023 DISPLAY="Processing..."` on state changes; `TIMED` repeats the device state every N seconds. Error codes (jam, paper out, etc.) have not been seen yet.
- `@PJL INFO STATUS`, `@PJL INFO PAGECOUNT` (total pages the machine has ever printed) answer on a fresh connection when no job connection is open. **While a job connection is open, a second connection gets no answer.** `INFO JOBS`, `INFO LOG`, `INFO PRODINFO` and `INQUIRE PAGECOUNT` are not supported.
- If our side closes (FIN) right after sending, as the agent did, the printer closes at once and sends **no** messages. So that close means "all data received", not "printed".
- After the pages were reported the printer stayed at "Processing..." for minutes with the page counter static while the job connection had been closed by us; it later went back to Ready. Cause not understood (possibly the printer's own job timeout).
- The printer's IPP interface (https port 443, `/ipp/print`) answers `Get-Jobs` with name and state, but only lists jobs submitted over IPP, not raw-port jobs.


## Paper trays as loaded (owner, 2026-11-01)

| Tray (printer name) | Holds | Notes |
|---|---|---|
| TRAY1 (INTRAY2) | Letter, loaded long-edge for **booklets** (the printer calls it LETTER-R) | Booklets need this orientation; Letter booklets already print from it |
| TRAY2 (INTRAY3) | **Ledger** (11x17) | `PAPER=LEDGER` finds it by itself (proven 2026-10-26) |
| TRAY3, TRAY4 (INTRAY5, INTRAY6) | regular Letter, portrait, 1500 sheets each | cannot make booklets (wrong orientation), fine for everything else |
| BYPASS (INTRAY1) | **cardstock** is the tray's configured type (Letter) | the likely route for hardstock/labels; needs the right paper loaded or the printer waits |

Rule that follows: the printer chooses the tray from `PAPER` (+ `MEDIATYPE`), so a job should ask for a size and type and not name a tray. **Never send a size or type nothing is loaded for** (Legal, A4, A3, Statement and so on are not loaded anywhere): the printer stops and asks for paper, and every later job waits behind it until someone cancels at the panel. Printio therefore advertises and accepts only Letter and Ledger for now.

## Hebrew and fonts (2026-11-01)

Trigger: a 2-page Hebrew study calendar (probably made by an AI/HTML tool, sent twice from the print dialog, 140 KB then
1.3 MB) came out badly garbled. The stored files could not be inspected, so the question was whether Printio can corrupt
Hebrew, and if the printer might.

**Verified by tests (no real printer involved)**
- `apps/web/lib/pdf/hebrew-fidelity.test.ts`: Hebrew PDFs (David Libre as subset, full font, mixed Hebrew/Latin/digits/nikud,
  multi-page, with an attachment + JavaScript so the sanitizer rewrites the file, landscape and odd sizes, `/Rotate` 90/270,
  object streams, Resources/MediaBox/Rotate inherited from the page tree) go through every stage in the order
  `create-print-job.ts` uses: preflight + sanitize, page subset, booklet padding + imposition (left and right binding, fill and
  keep), the stamp. For each, the text pdfjs extracts per page, the set of fonts per page and the ToUnicode maps are unchanged
  (booklet sheet sides hold exactly their two source pages' characters). **No Printio step changed Hebrew text or dropped a
  font in any of these.** pdf-lib copies font and CIDToGIDMap streams byte for byte; none of our steps re-encodes text.
- Safeguard in the pipeline (`lib/pdf/text-fidelity.ts`): if the non-Latin text of the derived file differs from the upload
  (per page, through the page-range and booklet page mapping), the job is held with "Printio could not prepare this file without
  changing its text. Nothing was printed..." and nothing is sent. Fails open on errors or timeout.

**Not verified**
- Anything about the printer's own PDF interpreter. The check above proves Printio's file says the same as the upload, not
  that the Kyocera draws it correctly.
- Suspects on the printer side (not guessed at, not tested): Type 3 fonts (what some HTML-to-PDF tools emit for Hebrew web
  fonts), CID TrueType fonts with unusual cmaps or a missing/odd CIDToGIDMap, fonts with an invalid or absent ToUnicode, very
  large embedded fonts (the 1.3 MB version probably had the whole font), fonts with restricted embedding flags, and Hebrew text
  that depends on OpenType shaping/positioning (nikud placement) instead of precomposed glyphs.
- The two sends of the real file were not compared with a viewer first. The cheapest first step is: open the same PDF in
  Chrome/Acrobat. If it is garbled there too, the PDF itself is broken (regenerate it); if fine there, test the printer below.

**Real-printer check (owner)**
```
node tools/raw-print/make-hebrew-tests.mjs            # makes tools/raw-print/hebrew-out/A-subset.pdf, B-full.pdf, C-mixed.pdf
node tools/raw-print/send-labelled.mjs tools/raw-print/hebrew-out/A-subset.pdf <printer-ip> "HEB A SUBSET"
node tools/raw-print/send-labelled.mjs tools/raw-print/hebrew-out/B-full.pdf   <printer-ip> "HEB B FULL"
node tools/raw-print/send-labelled.mjs tools/raw-print/hebrew-out/C-mixed.pdf  <printer-ip> "HEB C MIXED"
```
Each page says which file it is in large Latin letters and what to expect. Record here which of A, B, C printed correctly.
If all print fine, the printer handles ordinary TrueType Hebrew and the culprit is the source file's font type; then ask
whoever regenerates the PDF to export from a tool that embeds TrueType (not Type 3) fonts, or print it via Chrome's Save as PDF.

### Labelled tests, finishing combinations (2026-11-01, second round)

| Test | Settings sent | What came out |
|---|---|---|
| P1 | `DUPLEX=ON BINDING=LONGEDGE OUTBIN=OPTIONFACEDOWN FINISH=KPUNCH` (4 pages, 2 sheets) | **Double-sided, 3 holes on the left side. Proven.** |
| P2 | `DUPLEX=OFF OUTBIN=OPTIONFACEDOWN STAPLEOPTION=ONE FINISH=KPNCHANDSTPL` (4 single-sided sheets) | **A staple at the top left and 3 holes on the left. Proven.** |
| P3 | `DUPLEX=ON BINDING=LONGEDGE OUTBIN=OPTIONFACEDOWN STAPLEOPTION=TWO FINISH=STAPLE` (4 pages, 2 sheets) | Double-sided, but **one staple at the top left**, not two on the left. **Not as asked: held.** (Single-sided `STAPLEOPTION=TWO` does give two left staples, T1B.) |
