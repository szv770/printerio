import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { parseRememberedChoices, rememberedForForm, type RememberedChoices } from "@/lib/print-start-choices";

type Client = SupabaseClient<Database>;

/**
 * The member's own print-page preference (migration 0056, table user_print_preferences). Everything here is best effort:
 * the table may not exist yet (migration not applied), or any read/write may fail. A failure ALWAYS means "setting off"
 * and never throws, so the print page and the profile page keep working exactly as without the setting.
 */
export interface PrintPreferences {
  /** False when the table is missing or unreadable: the profile page then hides the checkbox. */
  available: boolean;
  rememberLast: boolean;
  /** What the print form may start from: only when rememberLast is on, validated, and never with a booklet. */
  remembered: RememberedChoices | null;
}

export const PRINT_PREFERENCES_OFF: PrintPreferences = { available: false, rememberLast: false, remembered: null };

export async function readPrintPreferences(supabase: Client, userId: string): Promise<PrintPreferences> {
  try {
    const { data, error } = await supabase.from("user_print_preferences").select("remember_last, last_choices").eq("user_id", userId).maybeSingle();
    if (error) return PRINT_PREFERENCES_OFF;
    if (!data || data.remember_last !== true) return { available: true, rememberLast: false, remembered: null };
    return { available: true, rememberLast: true, remembered: rememberedForForm(data.last_choices) };
  } catch {
    return PRINT_PREFERENCES_OFF;
  }
}

/** Turns the setting on or off. Turning it off also forgets the stored choices. Returns false when it could not be saved. */
export async function saveRememberLast(supabase: Client, userId: string, rememberLast: boolean): Promise<boolean> {
  try {
    const now = new Date().toISOString();
    const row: Database["public"]["Tables"]["user_print_preferences"]["Insert"] = { user_id: userId, remember_last: rememberLast, updated_at: now };
    if (!rememberLast) row.last_choices = null;
    const { error } = await supabase.from("user_print_preferences").upsert(row, { onConflict: "user_id" });
    return !error;
  } catch {
    return false;
  }
}

/** What a submitted job chose, in the form's own words. Keeps only fields the form understands. */
export function lastChoicesFromSubmit(c: {
  printerProfileId: string;
  sides: string;
  staple: string;
  booklet: string;
  copies: number;
  colorMode: string;
  paperSize: string;
  punch: boolean;
  bookletFit: string;
  bookletSheet: string;
}): RememberedChoices {
  return parseRememberedChoices({
    profileId: c.printerProfileId,
    sides: c.sides,
    staple: c.staple,
    booklet: c.booklet,
    copies: c.copies,
    colorMode: c.colorMode,
    paperSize: c.paperSize,
    punch: c.punch,
    bookletFit: c.bookletFit,
    bookletSheet: c.bookletSheet,
  });
}

/**
 * After a job was submitted: store its choices, but ONLY when the member's setting is on. One statement, filtered on
 * remember_last = true, so with the setting off (or no row, or no table) nothing is written. Never throws.
 */
export async function writeLastChoices(supabase: Client, userId: string, choices: RememberedChoices): Promise<void> {
  try {
    await supabase
      .from("user_print_preferences")
      .update({ last_choices: choices as Json, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("remember_last", true);
  } catch {
    /* the choices are a convenience; a failed save never touches the job that was just created */
  }
}
