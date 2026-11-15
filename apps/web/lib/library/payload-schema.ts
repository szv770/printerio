import { z } from "zod";
import type { EntrySection, LikkutPage, ListPage } from "@printio/shared/library/mafteiach-parse";
import type { PageRef } from "@printio/shared/library/mafteiach-fetch";

/**
 * What the website accepts from a print server as the parsed result of a library page. The shapes are the ones the library
 * screens already rely on (the exported types in packages/shared/src/library/mafteiach-parse.ts); anything else, any extra
 * field, any string or list over the generous limits, and any link that is not an https Google Drive or Docs file is refused.
 * The `: z.ZodType<...>` annotations make the compiler fail if the parser's types and these schemas ever drift apart.
 */

/** Largest accepted payload (UTF-8 bytes of its JSON). The database check is 1.5 MB on the jsonb's own text, which is a little longer. */
export const MAX_PAYLOAD_BYTES = 1_300_000;

const text = (max: number) => z.string().max(max);
const MAX_URL = 1000;

const driveUrl = z
  .string()
  .max(MAX_URL)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" && (u.hostname === "drive.google.com" || u.hostname === "docs.google.com");
    } catch {
      return false;
    }
  }, "not an https Google Drive or Docs address");

const link = z.object({ label: text(500), url: driveUrl }).strict();
const links = z.array(link).max(60);

const likkutEntry = z.object({ id: text(100), label: text(300), summary: text(10000), links }).strict();
const likkutParsha = z.object({ name: text(200), entries: z.array(likkutEntry).max(3000) }).strict();

export const likkutPageSchema: z.ZodType<LikkutPage> = z
  .object({
    volumes: z.array(z.object({ n: z.number().int().min(0).max(1000), label: text(200) }).strict()).max(300),
    current: z.number().int().min(0).max(1000).nullable(),
    parshiyos: z.array(likkutParsha).max(200),
  })
  .strict();

const listEntry = z
  .object({
    kind: z.enum(["maamor", "farbrengen"]),
    id: text(100),
    path: z.string().regex(/^\/(maamorim|all)\/[A-Za-z0-9_-]{1,40}$/),
    heading: text(300),
    title: text(1000),
    note: text(300),
    series: text(500),
  })
  .strict();

export const listPageSchema: z.ZodType<ListPage> = z
  .object({
    years: z.array(z.object({ year: z.string().regex(/^[0-9_]{1,12}$/), label: text(200), current: z.boolean() }).strict()).max(500),
    entries: z.array(listEntry).max(6000),
  })
  .strict();

export const entrySectionsSchema: z.ZodType<EntrySection[]> = z
  .array(
    z
      .object({
        title: text(500),
        groups: z.array(z.object({ label: text(500), links }).strict()).max(100),
      })
      .strict(),
  )
  .max(100);

export type PayloadCheck = { ok: true; payload: LikkutPage | ListPage | EntrySection[] } | { ok: false; code: "too_large" | "invalid" | "empty"; message: string };

/**
 * Checks a payload against the kind of page the JOB asked for (never what the print server says it is). The same "is there
 * anything on it" rule as the live path: a Likkutei volume with no parshiyos, or a list with no years and no entries, is the
 * "page looks different today" case and is refused (the server should report it as a failure instead).
 */
export function checkPayload(ref: PageRef, payload: unknown): PayloadCheck {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8");
  } catch {
    return { ok: false, code: "invalid", message: "The payload is not JSON." };
  }
  if (bytes > MAX_PAYLOAD_BYTES) return { ok: false, code: "too_large", message: "The payload is too large." };

  if (ref.kind === "likkutei") {
    const r = likkutPageSchema.safeParse(payload);
    if (!r.success) return { ok: false, code: "invalid", message: "The payload is not a Likkutei Sichos page." };
    return r.data.parshiyos.length > 0 ? { ok: true, payload: r.data } : { ok: false, code: "empty", message: "The page has nothing on it." };
  }
  if (ref.kind === "list") {
    const r = listPageSchema.safeParse(payload);
    if (!r.success) return { ok: false, code: "invalid", message: "The payload is not a library list page." };
    return r.data.years.length > 0 || r.data.entries.length > 0 ? { ok: true, payload: r.data } : { ok: false, code: "empty", message: "The page has nothing on it." };
  }
  const r = entrySectionsSchema.safeParse(payload);
  if (!r.success) return { ok: false, code: "invalid", message: "The payload is not a library entry." };
  return { ok: true, payload: r.data };
}
