# Staple proving plan (owner ask 3; written 2026-11-15)

Goal: find out which staple positions the Kyocera TASKalfa MZ8500i really makes, so Printio only ever OFFERS what has printed on this printer. Nothing is added to the website or the print dialog until its row says "proven". Background and the full audit: `docs/BACKLOG.md` (ask 3) and `docs/kyocera-raw-print.md` ("Staple position map").

## What we already know (from earlier labelled prints, `docs/kyocera-raw-print.md`)
| Wanted | What was sent | Result |
|---|---|---|
| Top-left | `STAPLEOPTION=ONE` | proven |
| Top-right | `STAPLEOPTION=ONE` + `KFEEDEDGE=SHORTEDGE` | proven |
| Bottom-left | `STAPLEOPTION=ONEOPPOSED` | proven, **but not yet offered** in the print dialog (IPP value 21) or the website form |
| Two staples on the left | `STAPLEOPTION=TWO` | proven **single-sided only**; double-sided (`DUPLEX=ON BINDING=LONGEDGE`) gave ONE top-left staple |
| Bottom-right, tried the obvious way | `ONEOPPOSED` + `KFEEDEDGE=SHORTEDGE` (P2) and `ONE` + `BINDING=SHORTEDGE` (P3) | both gave **top-left**: so this is NOT how to get bottom-right |

The printer's own PJL vocabulary has no position keyword (`STAPLEOPTION` = DEFAULT, ONE, TWO, ONEOPPOSED), so each new position is an experiment.

## The four test sets (8 sheets of Letter in total; each set is two sheets, so the printer can staple them)
| # | Tries | Sent | What we hope to see |
|---|---|---|---|
| S1 | two staples along the TOP edge | upright pages, `STAPLEOPTION=TWO` + `KFEEDEDGE=SHORTEDGE`, single-sided | two staples on the top edge |
| S2 | bottom-right, by turning the page | pages stored upside down, `STAPLEOPTION=ONE` (top-left of the sheet) | when you turn the sheet to read it, ONE staple at the bottom-right |
| S3 | two staples on the left, double-sided | 4 upright pages, `DUPLEX=ON BINDING=LONGEDGE`, `STAPLEOPTION=TWO` + `KFEEDEDGE=LONGEDGE` | two staples on the left edge (the earlier try gave one top-left) |
| S4 | two staples on the RIGHT edge, by turning the page | pages stored upside down, `STAPLEOPTION=TWO` (the left edge of the sheet) | when you turn the sheet to read it, two staples on the right edge |

Why S2 and S4 can work: the printer puts the staple at a fixed place on the SHEET as it is fed. If the page content is stored upside down, the reader turns the sheet around, and that same physical corner is then at the opposite side from the reader's point of view. It only suits portrait pages, and Printio would label such an option plainly (for example "Bottom-right (page printed turned around)").

## Safety (read before sending anything)
- These are the same kind of one-job settings as the earlier proven tests (`@PJL SET` applies to that job only; it does not change the printer's saved settings). The tool is `tools/raw-print/send-labelled.mjs` (used for the earlier proofs); it stamps a label on page 1 so every sheet identifies itself.
- Send ONE test at a time and wait for it to finish. Only Letter is loaded, and the sets use plain Letter. Do not send more than these four (earlier rounds printed about 100 test sheets; keep it to eight).
- If the printer stops, asks for paper, or shows a finisher or staple error: stop, do not retry, and tell me what the display says.
- Never send a document that could change the printer's settings (`docs/SECURITY.md`); these test files are our own generated pages.

## Steps (on a PC that can reach the printer at 192.168.100.168 and has the repo checked out and installed: the dev PC "SZV-PC", or the server "MLM Office")
Open a terminal in the Printio folder. Type these one line at a time.

1. `git pull origin claude/upcoming-large-project-3d2j9p`
2. `node tools/raw-print/make-staple-tests.mjs` (it prints "wrote ..." three times; it only writes three small PDFs into `tools/raw-print/staple-out/`)
3. **S1:** `node tools/raw-print/run-staple-round.mjs 1`
4. When it has come out: **S2:** `node tools/raw-print/run-staple-round.mjs 2`
5. Then **S3:** `node tools/raw-print/run-staple-round.mjs 3`
6. Then **S4:** `node tools/raw-print/run-staple-round.mjs 4`

(Another printer address: add it at the end, for example `node tools/raw-print/run-staple-round.mjs 1 192.168.100.170`. The runner refuses anything that is not a plain number address.)

What each one runs, for reference (the runner uses `tools/raw-print/send-labelled.mjs` with exactly these one-job settings; checked against a fake printer that captured the bytes):
- S1: `upright-2pages.pdf`, `DUPLEX=OFF OUTBIN=OPTIONFACEDOWN STAPLEOPTION=TWO KFEEDEDGE=SHORTEDGE FINISH=STAPLE`
- S2: `rot180-2pages.pdf`, `DUPLEX=OFF OUTBIN=OPTIONFACEDOWN STAPLEOPTION=ONE FINISH=STAPLE`
- S3: `upright-4pages.pdf`, `DUPLEX=ON BINDING=LONGEDGE OUTBIN=OPTIONFACEDOWN STAPLEOPTION=TWO KFEEDEDGE=LONGEDGE FINISH=STAPLE`
- S4: `rot180-2pages.pdf`, `DUPLEX=OFF OUTBIN=OPTIONFACEDOWN STAPLEOPTION=TWO FINISH=STAPLE`

## How to read each set and what to tell me
Hold each stapled set so the big word **TOP** is at the top and the text reads normally (turn S2 and S4 round: they were printed upside down on purpose). Then tell me, for each of S1 to S4: **where the staple(s) are** (top-left, top-right, bottom-left, bottom-right, left edge, right edge or top edge), **how many**, and anything odd (no staple, crooked, a printer message). A phone photo of each set, laid on a table with TOP at the top, is even better. Fill the table:

| # | Staples seen (where, how many) | Notes |
|---|---|---|
| S1 | | |
| S2 | | |
| S3 | | |
| S4 | | |

## What happens with the results (code, after the results; nothing before)
1. **Bottom-left** (already proven): wire into the website form (`StapleChoice`) and the print dialog (IPP value 21). No new test needed.
2. Each of S1 to S4 that matched its hope becomes a new row in `PROVEN_FINISHING_COMBOS` (`packages/shared/src/pjl.ts`) with `proven: true` and its proof text, then is added to the website form, the dialog map (`apps/web/lib/gateway/ipp-choices.ts`) and, for the turned-page ones, the PDF is rotated by Printio before sending, with a plain label.
3. Anything that did not work stays held with a plain reason. `docs/FEATURES.md` is updated in the same PR ("Built, testing" until you have seen it from a real device).
