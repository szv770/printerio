-- Printio: printer_profiles.description/icon_key (admin-facing profile
-- presentation, so a user picks a profile by what it *does* rather than a
-- cryptic internal label - see PrintersPanel.tsx / PrintForm.tsx), and
-- RTL-aware booklet binding side ("left edge binding" / "right edge
-- binding" - matching the Kyocera KX driver's own booklet Layout-tab
-- terminology for this printer family, see docs/printer-setup.md and
-- docs/architecture.md sec 8). apps/web/lib/pdf/imposition.ts's
-- `bindingSide` parameter is what actually acts on this.

-- ============================================================================
-- printer_profiles: description + icon_key (student/staff-facing profile picker)
-- ============================================================================
alter table printer_profiles add column description text;

comment on column printer_profiles.description is
  'Short admin-written blurb shown to a user picking a profile in the print '
  'form (e.g. "Black & white, double-sided - everyday documents"). Nullable '
  '- a profile with no description just shows its existing label alone.';

-- Curated allow-list only (never free text) - a profile can only ever
-- reference one of these known-safe lucide-react icon names, each verified
-- to actually exist in the installed lucide-react@0.469.0 package.
-- apps/web/lib/printer-profile-icons.ts is the single source of truth the UI
-- reads this same list from (keep both in sync if this list ever changes).
-- This app deliberately never uses emoji anywhere (an earlier round replaced
-- every emoji status indicator with lucide-react) - this CHECK is what keeps
-- that convention enforceable at the database level, not just a UI
-- convention a direct insert could bypass.
alter table printer_profiles add column icon_key text
  check (icon_key is null or icon_key in (
    'flip-vertical', -- duplex / double-sided
    'copy-plus',     -- multiple copies
    'palette',       -- color
    'book-open',     -- booklet
    'paperclip',     -- staple
    'circle-dot',    -- hole punch
    'star'           -- standard / default profile
  ));

comment on column printer_profiles.icon_key is
  'Optional lucide-react icon name shown next to this profile wherever it is '
  'presented for selection (apps/web/lib/printer-profile-icons.ts). '
  'Constrained to a small curated allow-list (never free text) so a profile '
  'can never reference an arbitrary/unsafe icon string. Null = no icon; the '
  'label/description are shown alone.';

-- ============================================================================
-- RTL-aware booklet binding side
-- ============================================================================
-- "left edge binding" (default - today's existing, unchanged imposition
-- behavior) vs "right edge binding" (mirrors the imposition so folding the
-- sheet and reading right-to-left, e.g. Hebrew, produces pages in the
-- correct order) - see apps/web/lib/pdf/imposition.ts's `bindingSide`
-- parameter and its proof-style test for the actual transform and why it's
-- correct.
alter table printer_profiles add column booklet_binding_side text not null default 'left'
  check (booklet_binding_side in ('left', 'right'));

comment on column printer_profiles.booklet_binding_side is
  'Which edge a booklet job''s pages are imposed to bind on - "left edge '
  'binding" (default, matches the Kyocera KX driver''s own Layout-tab term '
  'for LTR-read booklets - today''s existing, unchanged imposition '
  'behavior) or "right edge binding" (mirrors the imposition for RTL, e.g. '
  'Hebrew, reading order - see apps/web/lib/pdf/imposition.ts and '
  'docs/architecture.md sec 8). Only meaningful when '
  'declared_capabilities.booklet is true, but stored regardless of that flag '
  '- simpler than a conditional column, and harmless for a non-booklet '
  'profile since it is then simply never read. A per-job override is also '
  'available at print-submission time (apps/web/app/(dashboard)/print) '
  'without changing this stored default.';

alter table organization_settings add column default_booklet_binding_side text not null default 'left'
  check (default_booklet_binding_side in ('left', 'right'));

comment on column organization_settings.default_booklet_binding_side is
  'Prefills printer_profiles.booklet_binding_side when an org_admin creates '
  'a new booklet-capable profile (app/admin/printers) - does not itself '
  'affect any existing profile or in-flight job. Defaults to ''left'' (same '
  'as printer_profiles.booklet_binding_side''s own default) so an existing '
  'organization does not change behavior just because this column appeared; '
  'an org_admin whose organization reads right-to-left sets this to '
  '''right'' once from app/admin/settings, so every subsequently created '
  'booklet profile defaults to the binding side that actually matches how '
  'this organization reads, without re-flipping it by hand every time.';
