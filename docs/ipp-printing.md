# Native printing (IPP gateway) - design

Status: **design agreed in conversation, nothing built yet.** Next step is the Phase 0 spike.

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
