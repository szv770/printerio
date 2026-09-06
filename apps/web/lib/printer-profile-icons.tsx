import type { LucideIcon } from "lucide-react";
import { BookOpen, CircleDot, CopyPlus, FlipVertical, Palette, Paperclip, Star } from "lucide-react";

/**
 * Curated allow-list of lucide-react icons a `printer_profiles.icon_key` may
 * reference (supabase/migrations/0017_*.sql's CHECK constraint mirrors this
 * exact list - keep both in sync if it ever changes). Deliberately NOT free
 * text: an admin picks one of these from a fixed picker (PrintersPanel.tsx),
 * never types an arbitrary string, so a profile can never end up referencing
 * an unsafe or nonexistent icon name. Every name here was verified against
 * the installed lucide-react@0.469.0 package before being added - see
 * apps/web/lib/pdf/imposition.ts's sibling doc comments for this app's
 * general "verify before using" convention around lucide.
 *
 * This app deliberately never uses emoji anywhere (an earlier round replaced
 * every emoji status indicator with lucide-react) - these seven icons are the
 * only visual identity a profile is ever allowed to carry.
 */
export const PRINTER_PROFILE_ICON_KEYS = [
  "flip-vertical",
  "copy-plus",
  "palette",
  "book-open",
  "paperclip",
  "circle-dot",
  "star",
] as const;

export type PrinterProfileIconKey = (typeof PRINTER_PROFILE_ICON_KEYS)[number];

/** Short human-readable label for each icon, shown next to it in the picker. */
export const PRINTER_PROFILE_ICON_LABELS: Record<PrinterProfileIconKey, string> = {
  "flip-vertical": "Duplex / double-sided",
  "copy-plus": "Multiple copies",
  palette: "Color",
  "book-open": "Booklet",
  paperclip: "Staple",
  "circle-dot": "Hole punch",
  star: "Standard / default",
};

export const PRINTER_PROFILE_ICON_COMPONENTS: Record<PrinterProfileIconKey, LucideIcon> = {
  "flip-vertical": FlipVertical,
  "copy-plus": CopyPlus,
  palette: Palette,
  "book-open": BookOpen,
  paperclip: Paperclip,
  "circle-dot": CircleDot,
  star: Star,
};

export function isPrinterProfileIconKey(value: string): value is PrinterProfileIconKey {
  return (PRINTER_PROFILE_ICON_KEYS as readonly string[]).includes(value);
}
