# Kyocera raw print experiment

Goal: find out whether the Agent can send jobs **straight to the printer's raw port (9100)**,
bypassing the Windows queue (and the one-queue-per-finishing-profile limit) and SumatraPDF. This
is a separate track from the print-dialog feature in [ipp-printing.md](./ipp-printing.md) - nothing
there depends on it. Status: capture and decode done; **replay not yet tried**.

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

## Still unknown

- **Booklet fold / saddle-stitch**: no finishing command appeared in the booklet capture. Either that
  finisher option was not ticked, or it is expressed another way. Needs a capture with fold + stitch
  ticked (note exactly which driver options were selected).
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
