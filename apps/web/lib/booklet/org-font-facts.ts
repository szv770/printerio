import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { FONT_BUCKET, MAX_FONTS_PER_ORG } from "@/lib/booklet/custom-font";
import { factsFromName, type FontFacts } from "@/lib/booklet/font-families";
import { readFontFacts } from "@/lib/booklet/font-facts-read";

/**
 * The family and weight of each font an organization uploaded, read from the font files themselves (see font-families.ts).
 * Nothing about weights is stored: each file is read once per running server and remembered here (a stored file never changes;
 * a replaced font is a new row with a new path). `db` must be the service-role client, and every read is scoped to the
 * organization. A file that cannot be fetched or read falls back to its listed name ("... Bold"), so this never fails.
 */

const seen = new Map<string, FontFacts>();
const MAX_REMEMBERED = 500;

export async function loadOrgFontFacts(
  db: SupabaseClient<Database>,
  organizationId: string,
  fonts: readonly { id: string; name: string }[],
): Promise<Record<string, FontFacts>> {
  const out: Record<string, FontFacts> = {};
  if (fonts.length === 0) return out;
  let paths = new Map<string, string>();
  try {
    const { data } = await db.from("org_fonts").select("id, storage_path").eq("organization_id", organizationId).limit(50);
    if (Array.isArray(data)) paths = new Map(data.filter((r) => r && r.id && r.storage_path).map((r) => [r.id, r.storage_path as string]));
  } catch {
    /* names are enough */
  }
  await Promise.all(
    fonts.slice(0, MAX_FONTS_PER_ORG * 2).map(async (f) => {
      const path = paths.get(f.id);
      const key = `${organizationId}:${f.id}:${path ?? ""}`;
      const known = path ? seen.get(key) : undefined;
      if (known) {
        out[f.id] = known;
        return;
      }
      let facts = factsFromName(f.name);
      if (path) {
        try {
          const { data: blob, error } = await db.storage.from(FONT_BUCKET).download(path);
          if (!error && blob) {
            facts = readFontFacts(new Uint8Array(await blob.arrayBuffer()), f.name);
            if (seen.size >= MAX_REMEMBERED) seen.clear();
            seen.set(key, facts);
          }
        } catch {
          /* the name decides */
        }
      }
      out[f.id] = facts;
    }),
  );
  for (const f of fonts) out[f.id] ??= factsFromName(f.name);
  return out;
}
