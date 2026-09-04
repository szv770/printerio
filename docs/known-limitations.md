# Known Limitations

This file exists so nobody — including future us — mistakes an engineering convenience for
a guarantee. Every item below was confirmed against current official documentation
(Microsoft Learn, SumatraPDF docs, Kyocera docs, Supabase docs); see `docs/architecture.md`
for the research basis of each design decision this responds to.

## Printing / physical completion

- **"Submitted to spooler" ≠ "physically printed."** Windows exposes `JOB_STATUS_PRINTED`/
  `JOB_STATUS_COMPLETE` on a print job, but per Microsoft's own documentation, "port
  monitors that do not support TrueEndOfJob will set the job as JOB_STATUS_PRINTED right
  away after the job is submitted." Standard TCP/IP and most USB port monitors do not
  implement true end-of-job confirmation. PrintOS therefore tracks `submitted_to_spooler`
  and `completed` as distinct job states and does not claim the latter is proof of physical
  output. Genuine physical confirmation, where available at all, requires a vendor-specific
  bidirectional port monitor or SNMP polling of the device itself — not assumed present for
  every printer.
- **Finishing options (staple, punch, booklet/saddle-stitch) are not programmable from
  software.** They live in the Kyocera KX driver's private DEVMODE extension data, which
  Kyocera's own documentation exposes only through the driver's GUI ("Profiles"/Favorites)
  or an administrator-set per-queue "Printing Defaults." There is no documented CLI, REST
  API, or SDK to select a finishing preset at print time. PrintOS's answer is architectural,
  not a missing feature: administrators pre-configure one Windows printer queue per
  finishing profile, and the Agent only ever picks which queue to print to.
- **SumatraPDF controls a genuinely cross-driver-safe subset only**: page range,
  color/monochrome, duplex mode, fit/shrink/scale, collate, paper source/size (by the
  driver's own reported name), and copy count. It cannot set stapling, punching, booklet
  imposition, or output-bin selection — those are driver-private, per §above.
- **Kyocera SNMP telemetry is a hybrid of standard and proprietary MIBs.** Standard Printer
  MIB (RFC 3805, `1.3.6.1.2.1.43.*`) OIDs for toner-level-as-ratio and a generic error
  bitmask are portable. Kyocera's private MIB (`1.3.6.1.4.1.1347.*`) covers richer detail
  (per-tray, waste toner, granular errors) but its exact sub-OIDs and table indices have
  been repeatedly observed to differ across models/firmware in independent field reports.
  PrintOS treats the private-MIB OID map as **configurable per printer profile**, never a
  hardcoded constant, and if SNMP is unreachable or misconfigured, printing continues
  unaffected — telemetry is reported as "unavailable," never faked.
- **Declared printer capabilities are administrator-declared, not cloud-verified.** The
  database recording "this printer supports booklet" reflects what an admin configured on
  the Windows queue, not something the cloud has confirmed against the physical device.

## Multi-tenancy / security

- **JWT claims (organization/role) can be briefly stale** after a role change or removal,
  until the session token refreshes. Session lifetime is kept short, and sensitive actions
  re-check the live `organization_members` table rather than trusting a cached claim alone.
- **Storage signed URLs cannot be revoked early.** They are signed with a key separate from
  the Auth JWT signing key, so rotating the Auth secret does not invalidate an
  already-issued signed URL before its own expiry. Expiries are kept short (minutes) to
  bound this window rather than relying on revocation.

## Agent / offline behavior

- **An Agent that is offline is invisible, not necessarily broken.** Online/offline status
  is inferred from heartbeat staleness (no persistent connection is held open), so a network
  blip can transiently show an Agent as offline even if it recovers a moment later.
- **A "flake" is never assumed for a print failure.** Every failure becomes a recorded,
  bounded-retry `failed` state with an error history — the system does not silently retry
  forever or silently succeed after a transient error without recording what happened.

## V1 scope (intentionally not built yet)

- Real PDF color-content analysis (checking whether a "color" page is actually non-gray) is
  not implemented; approval policy for color is based on the *requested* print mode, which
  the spec confirms is sufficient and honest. If content-based detection is added later, it
  must be labeled as an analysis result with documented error rates, never treated as exact.
- SNMP telemetry, Google Drive/Microsoft 365 submission, a packaged Windows installer, and
  detailed cost/reporting dashboards are scaffolded architecturally (see
  `docs/architecture.md` and the phase plan in the root `README.md`) but are not fully
  implemented in this build — see `README.md` → "Current status & next phase."
