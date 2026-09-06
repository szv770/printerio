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
  implement true end-of-job confirmation. Printio therefore tracks `submitted_to_spooler`
  and `completed` as distinct job states and does not claim the latter is proof of physical
  output. Genuine physical confirmation, where available at all, requires a vendor-specific
  bidirectional port monitor or SNMP polling of the device itself — not assumed present for
  every printer.
- **Physical finishing (staple, hole punch, saddle-stitch fold) is not programmable from
  software.** These live in the Kyocera KX driver's private DEVMODE extension data, which
  Kyocera's own documentation exposes only through the driver's GUI ("Profiles"/Favorites)
  or an administrator-set per-queue "Printing Defaults." There is no documented CLI, REST
  API, or SDK to trigger the physical stapler/punch/folder unit at print time. Printio's
  answer is architectural, not a missing feature: administrators pre-configure one Windows
  printer queue per finishing profile, and the Agent only ever picks which queue to print
  to — the actual mechanical action still has to be a queue whose Printing Defaults already
  ask for it.
- **Booklet *page layout* is the one exception to the above — Printio does that part itself,
  in software, upstream of the driver entirely** (`apps/web/lib/pdf/imposition.ts`,
  architecture.md sec 8). This does not contradict the driver-private limitation: Printio
  never asks SumatraPDF or the driver to perform imposition (they still can't — see the next
  bullet), it pre-imposes the actual PDF pages (N-up saddle-stitch order, each page
  independently scaled to its half-sheet) *before* the file ever reaches SumatraPDF, then
  tells the driver to print that already-laid-out file at 100% scale (`fitMode: "noscale"`).
  The physical fold-and-staple action that turns those imposed sheets into a bound booklet is
  still the queue's own Printing Defaults, exactly like staple/punch above — Printio controls
  what's *on* each sheet, never the hardware that folds/staples the stack.
- **RTL-aware booklet binding side is supported** (`printer_profiles.booklet_binding_side` /
  `organization_settings.default_booklet_binding_side`, `imposeBookletPdf`'s `bindingSide`
  parameter — architecture.md sec 8), matching the Kyocera KX driver's own booklet "Left edge
  binding"/"Right edge binding" terminology. This is no longer a gap: an org whose readers
  read right-to-left (e.g. Hebrew) can set this per profile (with an org-level default and a
  per-job override) so a booklet folds and reads correctly for that direction, proved by
  `imposition.test.ts`'s object-graph-level decode of an actual imposed PDF, not just a
  transform-matrix assertion.
- **SumatraPDF controls a genuinely cross-driver-safe subset only**: page range,
  color/monochrome, duplex mode, fit/shrink/noscale, collate, paper source/size (by the
  driver's own reported name), and copy count. It cannot set stapling, punching, page
  imposition, or output-bin selection — those are driver-private, per the bullets above. Any
  page imposition that happens is Printio's own work in the PDF itself, before SumatraPDF is
  ever invoked, never something the driver was asked to do.
- **Kyocera SNMP telemetry is a hybrid of standard and proprietary MIBs.** Standard Printer
  MIB (RFC 3805, `1.3.6.1.2.1.43.*`) OIDs for toner-level-as-ratio and a generic error
  bitmask are portable. Kyocera's private MIB (`1.3.6.1.4.1.1347.*`) covers richer detail
  (per-tray, waste toner, granular errors) but its exact sub-OIDs and table indices have
  been repeatedly observed to differ across models/firmware in independent field reports.
  Printio treats the private-MIB OID map as **configurable per printer profile**, never a
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
