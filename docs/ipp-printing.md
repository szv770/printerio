# Native printing (IPP gateway) - design

Status: **design agreed in conversation, nothing built yet.** Next step is the Phase 0 spike.

## Direction update (2026-10-19, owner)

- Printio is a **virtual printer**: the main way staff print is from the normal print dialog / share sheet
  on phones and laptops (IPP gateway). Web upload stays as a supported backup, and is the place to choose
  booklet/finishing explicitly.
- The Agent should send jobs **straight to the printer's raw port 9100** (PJL header + PDF; no Windows queues,
  no per-finishing-profile queues, no SumatraPDF) - see [kyocera-raw-print.md](./kyocera-raw-print.md).
  Keep at most ONE Windows queue as a bad-case fallback an admin can switch to.
- Options in the dialog (copies, sides, staple, etc.) are mapped to PJL by the server. If a request can't be
  mapped with confidence, the job is **held** and the member or an admin picks the finishing in the dashboard.
- The Print Agent moves from the Raspberry Pi (test only) to the Windows 11 Pro server (Tailscale + RDP).
  The existing Agent still assumes Windows queues + SumatraPDF; a raw-port output path is a Phase 1 item.

## Goal

An org member adds "Printio" once as a normal printer on their own device (Windows, Mac,
iPhone/iPad, Android, Chromebook) and then prints from any app's normal print dialog - no
website upload. Scope is deliberately plain: copies, single/double-sided, page range, paper
size. No booklet/finishing from the print dialog (those stay in the web form).

Security bar: members of our own org only; the audit trail ("who printed what, when") on the
existing dashboard matters more than hardening. Fallback if this proves unreliable: the
printer's own built-in print inbox (e.g. email print) - simpler but unauthenticated.

## Shape

```
device print dialog --IPPS--> IPP gateway --> existing intake (preflight, policy, quota,
                                              approval) --> print_jobs --> Agent (unchanged)
```

The gateway is a second front door into the existing job pipeline. Agent, job states,
approvals, quotas and audit are unchanged. Jobs get `source = 'ipp'` and a
`SUBMITTED_VIA_IPP` audit event so the dashboard shows where each came from.

## Decisions

1. **Gateway runs outside Vercel** (Vercel caps request bodies ~4.5 MB; print clients stream
   large chunked uploads). Initial host: a spare PC we own, exposed through a Cloudflare
   Tunnel (no inbound firewall rule). Move to a small paid container later if wanted; the
   gateway is a plain Node service so the move is a redeploy.
2. **Identity = a personal secret URL**, `ipps://<host>/p/<token>`. Users only have Google
   sign-in (no passwords) and ChromeOS/iOS have no credential field for IPP. Token is
   per-user, hashed at rest, revocable, revoked when a member is deactivated, never logged.
   `requesting-user-name` from the client is ignored.
3. **One virtual printer per exposed printer profile** (admin toggle per profile). A print
   dialog can pick a printer, not a Windows queue. Most orgs will expose just one.
4. **Option mapping**: `copies`, `sides` (one-sided / two-sided-long-edge /
   two-sided-short-edge), `page-ranges`, `media`, `orientation-requested` -> existing policy
   engine. Printer advertised as monochrome-only (Kyocera MZ8500i).
5. **Accept, then hold/reject server-side.** OS dialogs only show a generic "Error" for a
   refused job, so over-quota / needs-approval jobs are accepted and shown with a readable
   reason on the web jobs page (optionally emailed).
6. **Formats**: prefer `application/pdf`. If a platform only sends raster (PWG/URF) or OXPS,
   convert to PDF in the gateway (tools can be installed on our own PC). Reuse existing
   `lib/pdf/preflight` checks.

## Known unknowns (verify in Phase 0, on real devices)

- What Windows' IPP class driver actually sends (PDF vs raster/OXPS) -> decides conversion work.
- iOS/iPadOS cannot add a printer by typing a URL. Plan: serve a one-tap AirPrint
  configuration profile (`IPAddress`, `ResourcePath`, `Port`, `ForceTLS`). Unconfirmed:
  that a user can install it themselves on an unsupervised device, and that it accepts a
  public hostname.
- ChromeOS manual "Add printer" takes an address and path but shows no credentials field -
  hence the secret URL. Confirm it accepts the full path and IPPS.
- Android: default print service / Mopria add-by-address behaviour with a path.
- macOS: add by URL, confirm IPPS + path.

## Phases

0. **Spike**: bare IPP endpoint (Get-Printer-Attributes, Validate-Job, Print-Job) that logs
   what each OS sends and saves received documents; Cloudflare quick tunnel; go/no-go per OS.
1. **MVP**: gateway, token table + migration, intake into the existing pipeline, status
   mapping, "Add to my device" page with per-OS steps.
2. **Admin**: per-profile exposure toggle, token revoke, source column on dashboard/reports.
3. **Polish**: `.mobileconfig` and Windows setup helpers, email notices, cancel from dialog.

## Phase 0 findings (real devices, 2026-10-16)

Tested through a Cloudflare quick tunnel to the spike on a Raspberry Pi (`tools/ipp-spike`).

| Platform | Result |
|---|---|
| Windows 11 | Adds by URL (4 clicks). Sends **PDF** via Create-Job + Send-Document. Carries copies, `sides` (incl. `two-sided-short-edge`), paper (Letter), orientation. A 16 MB job worked but was slow (Pi upload + free tunnel). |
| Android (Pixel 8) | Add-by-address accepts a **bare hostname only** (no path), so the secret cannot live in the path. Sends **PDF** via Validate-Job + Print-Job with `sides`, `copies`, `media-col`. |
| ChromeOS (probably) | `CUPS/2.4.11 ... aarch64` client sent a **PDF** via Create-Job + Send-Document. Still to confirm it was the Chromebook. |
| macOS / iOS | Not tested yet. |

No format conversion is needed on any platform tried. A scripted Windows one-click setup
(`Add-Printer -ConnectionName`, `Add-PrinterPort` + `Add-Printer`, `printui /if`) all failed;
the manual wizard works, so Windows setup stays manual.

**Consequence for identity:** put the per-member secret in the **hostname**
(`u-<code>.<domain>`, one DNS label so Cloudflare's free wildcard certificate covers it),
not the path. Domain: szvtech.org on Cloudflare; gateway name `printerio.szvtech.org`.

## Kyocera driver wire capture

Moved to [kyocera-raw-print.md](./kyocera-raw-print.md) (decoded: staple is plain PJL, duplex is a
PCL XL page attribute, booklet is driver-side imposition; replay experiment pending).

## Decisions made with the owner (2026-10-16)

- Members of the org only, invited one by one; no need for hard security, but each member has their
  own identity (own hostname) so the dashboard shows who printed what. Cover page with name/time
  can come later (the gateway holds each PDF, so it is easy).
- Scope from the print dialog: copies, single/double-sided, page range, paper size. Finishing from
  the dialog (`finishings`): none (3), staple 4 / 20 = top-left, 22 = top-right print as asked. Booklet-maker (13)
  and saddle-stitch (8) cannot say left or right binding, and a booklet must not depend on a printer-profile
  binding edge or on separate Windows queues, so the job is held ("Booklet: choose left or right binding.") with
  booklet already set. The member opens the job, taps Left or Right binding, then Print booklet; the website
  imposes it (left, or the mirrored right layout) on the raw path. Anything else is held as not available.
- Domain: `szvtech.org` on Cloudflare. Gateway `printerio.szvtech.org`. Per-member address must be a
  single DNS label under the zone (`u-<code>.szvtech.org`): Cloudflare's free certificate covers
  `*.szvtech.org` but not `*.printerio.szvtech.org`. Create one DNS record per invited member
  (tidy, revocable) or one wildcard; decide when building. Needs a real named tunnel, not a quick tunnel.
- Hosting: a spare PC / Raspberry Pi is fine for now (outbound tunnel only); paid hosting later.
- Windows setup stays the manual wizard; iPhone uses a `.mobileconfig` (untested); Android = copy
  address and paste; managed Chromebooks can be pushed from Google Admin, personal ones add manually.
- The Pi already runs a system `cloudflared` service (named tunnel). Do not touch it. Quick tunnels
  must be started with `--config /dev/null` or they inherit that service's config and return 404.

## Open items / next steps

0. iPhone: the profile downloads fine in Safari, but users got lost after the download. The spike's setup page now has numbered iPhone steps (Allow > Settings > Profile Downloaded or General > VPN & Device Management > Install x3) and opens the section for the detected device. Still unknown whether the printer then actually shows up in Share > Print.

1. Apple tests (iPhone profile, Mac `lpadmin`) - borrow a device.
2. Confirm the `CUPS/2.4.11 Linux aarch64` client was the Chromebook.
3. Kyocera raw-print: replay works (staple, saddle stitch); PDF-direct also works (plain PDF + PJL header); finishing mapping unfinished (see kyocera-raw-print.md).
4. Phase 1 build once Apple results are in: gateway service, per-member hostnames, token/identity
   table + migration, intake through the existing preflight/policy/quota pipeline, `source='ipp'`.
5. Policy question for Phase 1: map Windows' `two-sided-short-edge` / Android's `two-sided-long-edge`
   to the existing duplex setting; paper size sent is Letter (we advertise A4 default).

## Presets via paper type

The OS print dialog has no "booklet" option, so Printio uses the dialog's PAPER TYPE list as a preset selector inside the one printer (no extra printers).

- Advertised (`apps/gateway/src/ipp/printer-attributes.ts`): `media-type-supported` = `stationery` (default, plain paper), then the preset names from `packages/shared/src/print-presets.ts`: "Booklet - right edge, stapled", "Booklet - left edge, stapled", "2 pages per sheet", "4 pages per sheet", "Same page twice per sheet (cut in half)". `media-type` is also in `media-col-default`, `media-col-ready` and `media-col-database` (every size x every type) and in `job-creation-attributes-supported`. All values go out as IPP `name` (the codec writes one tag per attribute). Sizes and every other attribute are unchanged.
- Mapped (`apps/web/lib/gateway/ipp-choices.ts`): the paper type is read from top-level `media-type` or from inside `media-col` (Windows already sends `media-type: stationery` there). A preset name (case/space-insensitive) forces booklet side, staple none, no punch and, for booklets, two sides; it overrides the dialog's finishings and sides. Copies, page range, orientation and paper size stay the dialog's. Layout presets return a `layout` that finalize passes to `createPrintJob` / `intakePrintJob` (`JobOptions.layout` -> `preparePdf`). No question about left or right binding is asked when a preset names the side.
- Not a preset: a standard IPP keyword (`stationery`, `cardstock`, ...) or no media-type prints exactly as before. An unknown custom name (e.g. a preset renamed after a phone cached the old list) is HELD with "The paper type "X" is not available any more. Open Printio > My jobs to choose how to print this."
- Logging: the `job_received` event detail now has `attributeNames` (what the OS sent) and `mediaType`, so the owner can see on a real device what arrives. `media-type` is part of the gateway's duplicate-job key.
- UNTESTED per OS: whether Windows, macOS, iOS/iPadOS, ChromeOS or Android draws a paper-type list from this printer at all (guess: Mac, ChromeOS, Android yes; Windows and iOS probably not), and whether they send the chosen value as `media-type` or inside `media-col`. Both are handled. Check the `job_received` events after a real print from each device and update this list.
