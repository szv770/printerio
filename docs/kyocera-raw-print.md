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

## Staple position map, PDF-direct path (2026-10-18, 6-page PDF, duplex long edge, positions as seen on the upright page)

| `KFEEDEDGE=LONGEDGE` | `STAPLEOPTION` | Staple |
|---|---|---|
| no | `ONE` | top-right |
| no | `ONEOPPOSED` | top-left |
| yes | `ONE` | top-left |
| yes | `ONEOPPOSED` | **bottom-left** |

Fits "each of the two switches rotates the staple 90 degrees around the page" (TR -> TL -> BL). Simple
recipes: top-right = `ONE` alone; top-left = `ONEOPPOSED` alone. Bottom-right not reachable with these two
switches. Likely depends on PDF page orientation (the test PDF's orientation was not recorded) - re-check with a
landscape PDF. The driver's PCL XL jobs behave differently (ONE alone = top-left there).

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
  This supersedes the older table above (that run was on a different PDF and put `ONE` at top-right). Top-right still unmapped (tests P1-P4:
  `KFEEDEDGE=SHORTEDGE` and `BINDING=SHORTEDGE` variants). Copies via `QTY` work (2 copies confirmed).
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
