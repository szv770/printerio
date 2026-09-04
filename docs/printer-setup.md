# Printer setup: Kyocera KX driver, Windows queues, and PrintOS profiles

This is the doc that gets a real printer working end to end. The target device
for this build is a **Kyocera TASKalfa MZ2501ci** — a genuine, current A3 color
MFP in Kyocera's newer "EvolutionNext" MZ-series. Read the caveat in §0 before
following the menu-by-menu steps below; the procedure itself is solid, the exact
wording of some menus is not yet verified against this specific model.

## 0. The finishing-options problem, and why the fix is one queue per profile

Finishing options — staple, hole punch, booklet/saddle-stitch — live inside the
Kyocera KX driver's private DEVMODE extension data. There is no cross-vendor
Windows API, no SumatraPDF command-line flag, and no documented Kyocera CLI/
REST/SDK hook that can select "staple this job" or "print this as a booklet" at
print time. Kyocera's own documented mechanism for a reusable finishing setup is
entirely inside the driver's Windows GUI: either the KX driver's own "Profiles"/
Favorites quick-set feature, or an administrator-set per-queue "Printing
Defaults." See [architecture.md sec 9](./architecture.md#9-printer-profiles--the-driverfinishing-architecture)
and [known-limitations.md](./known-limitations.md) for the full rationale — this
isn't a workaround PrintOS invented, it's the pattern Kyocera's own tooling
(including Kyocera Net Viewer for bulk deployment) assumes.

**Consequence:** PrintOS never tries to program finishing options at print
time. Instead, an administrator creates **one Windows printer queue per
finishing profile** (e.g. a plain-duplex queue, a stapled queue, a booklet
queue), bakes the desired finishing behavior into each queue's saved Printing
Defaults once, and PrintOS's Agent only ever picks *which queue* to send a job
to (architecture.md sec 9–10). What the Agent *can* control per job via
SumatraPDF is the generic, cross-driver-safe subset: page range, color/
monochrome, duplex mode, fit/scale, collate, paper source/size, and copy count
— never staple/punch/booklet imposition itself.

### A note on how confident to be in the steps below

Kyocera has **not yet published an MZ-series-specific KX driver user guide** in
any source available while writing this. The detailed Printing Preferences menu
wording below — the Device Settings tab layout, the exact finisher option
names — is drawn from KX driver guides for neighboring/prior-generation
TASKalfa models (2554ci/3554ci, 4054ci–7054ci, 306ci/356ci/406ci, 7353ci/
8353ci). Kyocera documents the KX driver as a stable architecture reused across
generations, and the MZ-series ships with the same KX driver family, so this
content is presented as **representative of the KX driver as documented for the
closest neighboring TASKalfa models, not a guide written specifically for the
MZ2501ci**. The overall procedure — enable installed finisher hardware in
Device Settings, then set duplex/staple/punch/booklet defaults in Printing
Preferences, then save as that queue's Printing Defaults or as a driver
Profile — should transfer without surprises, since it reflects the KX driver's
general architecture rather than a model-specific quirk. The exact on-screen
labels (a menu item reading "1,000-Sheet Finisher" vs. some other exact
string, for instance) should be treated as unverified until you have the actual
MZ2501ci's KX driver installed in front of you. **Please note any differences
you find** — the wording here should be corrected once verified rather than
trusted as a literal transcript.

## 1. Install the KX driver and create the base queue

1. Install the Kyocera KX driver for the TASKalfa MZ2501ci (from Kyocera's
   driver download page for this model, or the driver disc/package that
   shipped with the device). Use the KX driver specifically, not a generic/PCL
   fallback driver — the finishing UI and Profiles feature described below are
   KX-driver features.
2. Add a printer using that driver, pointed at the device's IP address and
   port (standard TCP/IP port, matching how the device is configured on your
   network — check the device's own network settings panel for its current
   IP if you don't already have it). Name this queue something clear and
   stable, e.g. `Kyocera_Main` — this exact string is what you'll later enter
   as `windows_queue_name` in the PrintOS dashboard, so avoid renaming it once
   profiles depend on it.

## 2. Enable installed finisher hardware (Device Settings)

Before any finishing option is selectable on the per-job Printing Preferences
tabs, the driver needs to be told what hardware is physically attached to
*this* device — nothing finishing-related is usable until this step is done.

1. Open **Devices and Printers** (or **Printers & Scanners**) → right-click
   `Kyocera_Main` → **Printer properties**.
2. Go to the **Device Settings** tab.
3. Set the installed options to match what is physically attached to your
   MZ2501ci: finisher type (e.g. none / an inner finisher / a saddle-stitch
   booklet finisher — whatever is actually installed), punch unit (if any,
   and which hole configuration), any paper decks/trays beyond the standard
   ones, and mailbox (if installed). This list of exact option names is what's
   unverified per §0 above — expect something close to "Finisher: [None /
   Inner Finisher / 1,000-Sheet Finisher / ...]" and "Punch Unit: [None /
   2-hole / 4-hole]," but confirm the literal wording against what's on screen.
4. Apply/OK. If a hardware option you expect to see isn't present, don't
   proceed to configure finishing defaults that depend on it — go back and
   confirm the driver is actually the KX driver and that it's been given a
   chance to detect the device's installed options (some KX driver installs
   offer a "communicate with the printer to detect installed options"
   button in Device Settings — use it if present rather than guessing).

## 3. Set this queue's finishing defaults (Printing Preferences)

1. Still in **Printer properties**, go to **General** tab → **Preferences**
   (or **Printer properties → Advanced → Printing Defaults**, which is the
   version that sets the *default* rather than just today's session default —
   use Printing Defaults, since that's what actually persists for every job
   sent to this queue without a user picking settings themselves).
2. Set duplex mode (Off / Long-edge bind / Short-edge bind), color mode,
   staple (if this is meant to be the stapled queue), punch (if this is meant
   to be the punched queue), and booklet/saddle-stitch layout with binding
   edge (if this is meant to be the booklet queue) to match the single
   finishing profile this queue represents. Each queue should represent
   exactly one coherent profile — don't try to make one queue serve multiple
   finishing combinations, since there is no per-job override mechanism
   available to PrintOS at print time (§0).
3. Apply/OK.

## 4. Add one additional queue per finishing profile you need

For each additional profile (e.g. `Kyocera_Main_Booklet`,
`Kyocera_Main_Stapled`), you have two equivalent options:

**Option A — a separate Windows queue (recommended, matches the
architecture's `windows_queue_name`-per-profile model directly):**
1. **Add Printer** again, using the KX driver, pointed at the **same** IP/
   port as `Kyocera_Main`.
2. Give it a distinct, clear name (e.g. `Kyocera_Main_Booklet`).
3. Repeat §2 (Device Settings — same physical hardware, so the same settings)
   and §3 (Printing Defaults — this queue's specific profile: booklet mode
   on, duplex forced by the booklet layout itself, etc.) for this new queue.

**Option B — the KX driver's own Profiles/Favorites feature:** from any
Printing Preferences tab, configure the desired combination, then use
**Save As** (or the Profiles/Favorites panel) to save it as a named profile —
Kyocera's KX driver supports up to 26 saved profiles per driver instance,
including the built-in "Factory Default." This is useful for a human
selecting a profile by hand at print time from the driver dialog, but **it is
not something PrintOS's Agent can select programmatically** — there is no
documented CLI/API to apply a saved profile at print time (this was confirmed
against Kyocera's own KX driver, Net Viewer, and Command Center RX
documentation — none expose a profile-switch hook to an external caller). If
you use Profiles, you still need one queue's Printing Defaults set to match
each profile PrintOS should be able to target, since the Agent only ever
selects a queue, never a saved profile inside a queue.

In practice: **use Option A for anything PrintOS's Agent needs to select
automatically.** Option B is a convenience for humans printing by hand outside
PrintOS, not a substitute for the per-queue defaults PrintOS relies on.

## 5. Register each queue as a `printer_profiles` row

Once a Windows queue's Printing Defaults are set the way you want, register it
in the PrintOS admin dashboard so the cloud/Agent can target it:

1. Ensure the physical printer has a `printers` row in PrintOS (Admin →
   Printers → New Printer, if this is the first profile for this device).
2. Create a `printer_profiles` row for this queue:
   - `windows_queue_name` **must exactly match** the Windows queue name as it
     appears in Devices and Printers (`Kyocera_Main`, `Kyocera_Main_Booklet`,
     etc.) — this is a plain string match on the Agent side (agent-api.md,
     architecture.md sec 9), so a typo or later rename silently breaks that
     profile. Case and any trailing characters matter.
   - `agent_id` — the Agent instance that has this Windows queue available to
     it (i.e. the Agent running on, or with access to, the machine where this
     queue is configured).
   - `declared_capabilities` (duplex/color/staple/booklet/punch) and
     `declared_paper_sizes` — set these to **match what you actually
     configured** on the Windows queue in §2–3, not what the physical printer
     is theoretically capable of. This field is administrator-declared, not
     cloud-verified (architecture.md sec 9) — PrintOS cannot introspect the
     driver's private DEVMODE finishing state, so an inaccurate declaration
     here is invisible to the software and will surface as a job that "should"
     staple but doesn't, or vice versa.
   - `key` and `label` — a short internal key (`booklet`, `stapled`, `main`)
     and a human-readable label shown in the admin UI.
3. Repeat for every queue created in §1 and §4.

## 6. SNMP telemetry (optional)

SNMP polling is not required for printing to work — it's optional telemetry
(toner level, error state) layered on top, and if unreachable or
misconfigured, printing continues unaffected; telemetry is reported as
"unavailable," never faked (known-limitations.md).

1. In **Command Center RX** (the device's built-in web management console —
   reach it by browsing to the device's IP address), go to **Management
   Settings → SNMP** and confirm SNMPv1/v2c (or SNMPv3, if you want
   authenticated/encrypted polling) is enabled.
2. For portable basics — toner level as a ratio, a generic error bitmask —
   the standard **Printer MIB (RFC 3805)** subtree
   (`1.3.6.1.2.1.43.*`, plus `1.3.6.1.2.1.25.3.*` Host Resources) is
   cross-vendor and safe to assume present.
3. For richer, Kyocera-specific detail (per-tray levels, waste toner box,
   granular per-finisher error state) you're in Kyocera's **private MIB**
   under `1.3.6.1.4.1.1347.*`. **Do not hardcode these OIDs as one universal
   constant set** — independent field reports (community monitoring-tool bug
   reports and multi-model MIB walks) show the private-MIB branch and table
   indices differ across Kyocera models and firmware versions (e.g. some
   devices answer under `.1347.41`, others `.1347.43`; per-model walks show
   different table layouts). PrintOS's schema reflects this:
   `printers.snmp_config` (see `supabase/migrations/0002_printing_tables.sql`)
   is a per-printer JSON config, not a hardcoded OID map — configure the
   actual OIDs for **this specific device** (verify with an SNMP walk against
   the real MZ2501ci, or a maintained per-model OID table) rather than
   copying an OID map you found for a different Kyocera model.

## 7. If something looks wrong — troubleshooting

- **A job prints with the wrong finishing (e.g. no staple on the "stapled"
  queue).** Almost always one of: (a) `windows_queue_name` in the
  `printer_profiles` row doesn't exactly match the real Windows queue name —
  check for a typo, extra space, or a queue that was renamed after the
  profile was created; (b) the queue's Printing Defaults weren't actually
  saved (re-open Printer Properties → Advanced → Printing Defaults and
  confirm the setting is still there — some Windows/driver combinations
  reset defaults on a driver update); (c) the corresponding hardware option
  wasn't enabled in Device Settings (§2) at all, so the setting silently has
  no effect regardless of what Printing Preferences shows.
- **A queue doesn't show up as something the Agent can target.** Confirm the
  Agent's own heartbeat is reporting this queue (agent-api.md `POST
  /api/agents/heartbeat`, `queues[]`) — the Agent can only discover queues
  that exist on the Windows machine it's running on/monitoring; a queue
  created on a different machine than the one running the Agent won't appear.
- **`declared_capabilities` says something the printer can't actually do.**
  This field is never cloud-verified (architecture.md sec 9) — go back to §2/
  §3 and confirm what's actually configured on the physical queue, then
  correct the dashboard row to match reality, not the other way around.
- **Menu wording in this doc doesn't match what you see on screen.** Expected,
  per §0 — this doc was written from neighboring-model KX driver guides, not
  an MZ2501ci-specific manual. Note the actual wording you find so this
  document can be corrected against the real driver.
