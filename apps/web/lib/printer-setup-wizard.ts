import type { PrinterProfileIconKey } from "./printer-profile-icons";

/**
 * Pure, framework-free logic for the guided printer setup wizard
 * (app/admin/printers/setup). Kept separate from the wizard's UI so the
 * archetype -> declared_capabilities/icon mapping is easy to unit-test
 * directly (see printer-setup-wizard.test.ts), matching this codebase's
 * existing convention of testing pure helpers rather than only through the
 * UI (e.g. lib/reports.ts, lib/pdf/imposition.ts).
 *
 * See docs/printer-setup.md for the underlying driver-configuration guidance
 * `driverGuidance` below is a short pointer into, not a restatement of.
 */

export type DeclaredCapabilities = {
  duplex: boolean;
  color: boolean;
  staple: boolean;
  booklet: boolean;
  punch: boolean;
};

const NO_CAPABILITIES: DeclaredCapabilities = {
  duplex: false,
  color: false,
  staple: false,
  booklet: false,
  punch: false,
};

/** Stable identifiers for the checklist offered in wizard Step 1. Order here
 *  is display order. */
export const PRINTER_ARCHETYPE_IDS = [
  "bw_simplex",
  "bw_duplex",
  "booklet_left",
  "booklet_right",
  "color",
  "stapled",
  "hole_punched",
] as const;

export type PrinterArchetypeId = (typeof PRINTER_ARCHETYPE_IDS)[number];

export interface PrinterArchetype {
  id: PrinterArchetypeId;
  /** Step 1 checklist label - exact wording the task specifies. */
  checklistLabel: string;
  /** Suggested printer_profiles.key - lowercase/underscore, matches the
   *  `key ~ '^[a-z0-9_]+$'` DB constraint and createPrinterProfileAction's
   *  own validation, so it can be submitted unmodified. */
  suggestedKey: string;
  suggestedLabel: string;
  suggestedDescription: string;
  declaredCapabilities: DeclaredCapabilities;
  /** Reused verbatim from lib/printer-profile-icons.tsx's curated allow-list
   *  - never a new/invented icon name. */
  iconKey: PrinterProfileIconKey;
  isBooklet: boolean;
  /** Short reference to what to configure in the driver's Printing Defaults
   *  for this finishing type - points into docs/printer-setup.md rather than
   *  duplicating its guidance. */
  driverGuidance: string;
}

const PRINTER_SETUP_DOC = "docs/printer-setup.md";

export const PRINTER_ARCHETYPES: Readonly<Record<PrinterArchetypeId, PrinterArchetype>> = {
  bw_simplex: {
    id: "bw_simplex",
    checklistLabel: "Black & white, single-sided",
    suggestedKey: "bw_simplex",
    suggestedLabel: "Black & White",
    suggestedDescription: "Black & white, single-sided - everyday documents",
    declaredCapabilities: { ...NO_CAPABILITIES },
    iconKey: "star",
    isBooklet: false,
    driverGuidance: `Leave duplex and color OFF in this queue's Printing Defaults - the plain default queue (${PRINTER_SETUP_DOC} §3).`,
  },
  bw_duplex: {
    id: "bw_duplex",
    checklistLabel: "Black & white, double-sided (duplex)",
    suggestedKey: "bw_duplex",
    suggestedLabel: "Black & White, Double-Sided",
    suggestedDescription: "Black & white, double-sided - everyday documents",
    declaredCapabilities: { ...NO_CAPABILITIES, duplex: true },
    iconKey: "flip-vertical",
    isBooklet: false,
    driverGuidance: `Set duplex mode (long-edge or short-edge bind, whichever this device uses) in Printing Defaults (${PRINTER_SETUP_DOC} §3).`,
  },
  booklet_left: {
    id: "booklet_left",
    checklistLabel: "Booklet (left edge binding)",
    suggestedKey: "booklet_left",
    suggestedLabel: "Booklet (Left Edge Binding)",
    suggestedDescription: "Saddle-stitched booklet, left-edge binding (LTR reading)",
    declaredCapabilities: { ...NO_CAPABILITIES, booklet: true },
    iconKey: "book-open",
    isBooklet: true,
    driverGuidance: `Turn on the physical saddle-stitch finisher, but leave the driver's own booklet page-layout toggle OFF - Printio already imposes booklet pages itself (${PRINTER_SETUP_DOC} §0/§3).`,
  },
  booklet_right: {
    id: "booklet_right",
    checklistLabel: "Booklet (right edge binding)",
    suggestedKey: "booklet_right",
    suggestedLabel: "Booklet (Right Edge Binding)",
    suggestedDescription: "Saddle-stitched booklet, right-edge binding (RTL reading, e.g. Hebrew)",
    declaredCapabilities: { ...NO_CAPABILITIES, booklet: true },
    iconKey: "book-open",
    isBooklet: true,
    driverGuidance: `Turn on the physical saddle-stitch finisher, but leave the driver's own booklet page-layout toggle OFF - Printio already imposes booklet pages itself (${PRINTER_SETUP_DOC} §0/§3).`,
  },
  color: {
    id: "color",
    checklistLabel: "Color",
    suggestedKey: "color",
    suggestedLabel: "Color",
    suggestedDescription: "Color printing",
    declaredCapabilities: { ...NO_CAPABILITIES, color: true },
    iconKey: "palette",
    isBooklet: false,
    driverGuidance: `Set color mode in Printing Defaults to match this queue's intended use (${PRINTER_SETUP_DOC} §3).`,
  },
  stapled: {
    id: "stapled",
    checklistLabel: "Stapled",
    suggestedKey: "stapled",
    suggestedLabel: "Stapled",
    suggestedDescription: "Stapled documents",
    declaredCapabilities: { ...NO_CAPABILITIES, staple: true },
    iconKey: "paperclip",
    isBooklet: false,
    driverGuidance: `Enable the stapler unit in Device Settings, then set the staple option in Printing Defaults (${PRINTER_SETUP_DOC} §2/§3).`,
  },
  hole_punched: {
    id: "hole_punched",
    checklistLabel: "Hole-punched",
    suggestedKey: "hole_punched",
    suggestedLabel: "Hole-Punched",
    suggestedDescription: "Hole-punched documents",
    declaredCapabilities: { ...NO_CAPABILITIES, punch: true },
    iconKey: "circle-dot",
    isBooklet: false,
    driverGuidance: `Enable the punch unit in Device Settings (and choose its hole configuration), then set punch in Printing Defaults (${PRINTER_SETUP_DOC} §2/§3).`,
  },
};

export function isPrinterArchetypeId(value: string): value is PrinterArchetypeId {
  return (PRINTER_ARCHETYPE_IDS as readonly string[]).includes(value);
}

/** A wizard Step 1 selection, turned into a concrete suggestion for the
 *  profile Step 3 will create. Everything here stays editable by the admin
 *  in Step 3 (label/description are shown, not silently trusted) - this is
 *  a starting point, not a final answer, mirroring how
 *  declared_capabilities/declared_paper_sizes are administrator-declared
 *  everywhere else in this app (docs/architecture.md sec 9). */
export interface RecipeCard {
  archetypeId: PrinterArchetypeId;
  key: string;
  label: string;
  description: string;
  iconKey: PrinterProfileIconKey;
  declaredCapabilities: DeclaredCapabilities;
  isBooklet: boolean;
  /** Always populated (mirrors printer_profiles.booklet_binding_side's own
   *  "stored regardless of the booklet flag" convention) - only meaningful
   *  when isBooklet is true. Prefilled from
   *  organization_settings.default_booklet_binding_side, the same read path
   *  NewProfileForm already uses (app/admin/printers/PrintersPanel.tsx) -
   *  still editable per-card in Step 3, exactly like NewProfileForm's own
   *  Select. */
  bookletBindingSide: "left" | "right";
  driverGuidance: string;
}

/** Builds one recipe card from a checked archetype. `defaultBookletBindingSide`
 *  is organization_settings.default_booklet_binding_side (default "left" if
 *  unset, matching that column's own DB default). */
export function buildRecipeCard(archetypeId: PrinterArchetypeId, defaultBookletBindingSide: "left" | "right" = "left"): RecipeCard {
  const archetype = PRINTER_ARCHETYPES[archetypeId];
  return {
    archetypeId: archetype.id,
    key: archetype.suggestedKey,
    label: archetype.suggestedLabel,
    description: archetype.suggestedDescription,
    iconKey: archetype.iconKey,
    declaredCapabilities: { ...archetype.declaredCapabilities },
    isBooklet: archetype.isBooklet,
    bookletBindingSide: defaultBookletBindingSide,
    driverGuidance: archetype.driverGuidance,
  };
}

/** Builds one recipe card per checked archetype, in checklist order,
 *  de-duplicated (checking the same archetype twice is a no-op, not two
 *  cards). */
export function buildRecipeCards(archetypeIds: readonly PrinterArchetypeId[], defaultBookletBindingSide: "left" | "right" = "left"): RecipeCard[] {
  const seen = new Set<PrinterArchetypeId>();
  const cards: RecipeCard[] = [];
  for (const id of archetypeIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    cards.push(buildRecipeCard(id, defaultBookletBindingSide));
  }
  return cards;
}
