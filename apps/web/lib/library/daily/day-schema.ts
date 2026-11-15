import { z } from "zod";
import type { ShiurDay } from "@printio/shared/library/daily/source";
import { OFFERED_STUDIES } from "./studies";

/**
 * What the website accepts from a print server as one day of daily study text (POST /api/agents/library/daily). The shape is
 * exactly what `parseShiurPage` returns (`ShiurDay` in packages/shared/src/library/daily/source.ts); the `: z.ZodType<ShiurDay>`
 * annotation makes the compiler fail if the two ever drift apart. Unknown fields are dropped (never stored), the study must be
 * one of the five the library offers (all allowed by the table's own check), and every string and list has a generous but real limit.
 */

/** The whole day's JSON may not be longer than this (UTF-8 bytes). The table allows 1.5 MB per row, and one row never holds more than the whole day. */
export const MAX_DAY_BYTES = 1_500_000;
/** Longest accepted portion line (the table's check is 300 characters). */
export const MAX_PORTION_CHARS = 300;

const block = z.object({
  kind: z.enum(["verse", "rashi", "note"]),
  num: z.string().max(50).optional(),
  he: z.string().max(20_000),
  en: z.string().max(20_000),
  leadHe: z.string().max(2_000).optional(),
  leadEn: z.string().max(2_000).optional(),
});

const section = z.object({
  heading: z.string().max(500),
  blocks: z.array(block).min(1).max(2_000),
});

const study = z.object({
  study: z.enum(OFFERED_STUDIES),
  portion: z.string().min(1).max(MAX_PORTION_CHARS),
  sections: z.array(section).min(1).max(300),
});

export const shiurDaySchema: z.ZodType<ShiurDay> = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  studies: z
    .array(study)
    .min(1)
    .max(OFFERED_STUDIES.length)
    .refine((list) => new Set(list.map((s) => s.study)).size === list.length, "a study appears twice"),
});
