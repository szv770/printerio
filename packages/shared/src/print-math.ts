/**
 * Print math: pages, sides, sheets, booklet padding, cost.
 * See docs/architecture.md sec 7-8 for the definitions and worked examples.
 *
 * These are deliberately kept as separate numbers rather than collapsed into
 * one "page count" - see docs/known-limitations.md for why color-content
 * detection is out of scope and requested color mode is used instead.
 */

export interface PrintMathInput {
  /** Server-verified source PDF page count (post booklet-padding if applicable). */
  pageCount: number;
  copies: number;
  duplex: boolean;
  booklet: boolean;
}

export interface PrintMathResult {
  printedSides: number;
  physicalSheets: number;
}

export function computePrintMath(input: PrintMathInput): PrintMathResult {
  const { pageCount, copies, duplex, booklet } = input;
  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    throw new Error(`pageCount must be a positive integer, got ${pageCount}`);
  }
  if (!Number.isInteger(copies) || copies <= 0) {
    throw new Error(`copies must be a positive integer, got ${copies}`);
  }

  const printedSides = pageCount * copies;

  // Booklet imposition places 4 pages per physical sheet (2 per side, always
  // duplex) - independent of the `duplex` flag, which only applies to
  // non-booklet layouts.
  const physicalSheets = booklet
    ? Math.ceil(pageCount / 4) * copies
    : Math.ceil(pageCount / (duplex ? 2 : 1)) * copies;

  return { printedSides, physicalSheets };
}

export interface BookletPaddingResult {
  paddedPages: number;
  blankPagesAdded: number;
  needsPadding: boolean;
}

/** Booklet imposition requires a page count that is a multiple of 4. */
export function computeBookletPadding(sourcePages: number): BookletPaddingResult {
  if (!Number.isInteger(sourcePages) || sourcePages <= 0) {
    throw new Error(`sourcePages must be a positive integer, got ${sourcePages}`);
  }
  const paddedPages = Math.ceil(sourcePages / 4) * 4;
  const blankPagesAdded = paddedPages - sourcePages;
  return { paddedPages, blankPagesAdded, needsPadding: blankPagesAdded > 0 };
}

/**
 * Optional per-organization pricing. Cost tracking is entirely optional - an
 * organization may track pages/sheets with no financial dimension at all
 * (pass `pricing: null`).
 */
export interface PricingConfig {
  bwPerSideCents: number;
  colorPerSideCents: number;
  /** Paper size key (matches printer_profiles.declared_paper_sizes) -> multiplier. */
  paperSizeMultipliers?: Record<string, number>;
  /** Flat fee per copy/output unit, not per side. */
  staplingFeeCentsPerCopy?: number;
  bookletFeeCentsPerCopy?: number;
}

export interface CostInput {
  printedSides: number;
  copies: number;
  colorMode: "bw" | "color";
  paperSize: string;
  finishingStaple: boolean;
  finishingBooklet: boolean;
  pricing: PricingConfig | null;
}

/** Returns null when the organization has not configured pricing. */
export function computeCostCents(input: CostInput): number | null {
  const { pricing } = input;
  if (!pricing) return null;

  const perSideCents = input.colorMode === "color" ? pricing.colorPerSideCents : pricing.bwPerSideCents;
  const multiplier = pricing.paperSizeMultipliers?.[input.paperSize] ?? 1;

  let totalCents = input.printedSides * perSideCents * multiplier;
  if (input.finishingStaple) totalCents += (pricing.staplingFeeCentsPerCopy ?? 0) * input.copies;
  if (input.finishingBooklet) totalCents += (pricing.bookletFeeCentsPerCopy ?? 0) * input.copies;

  return Math.round(totalCents);
}
