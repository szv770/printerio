/**
 * Turns a raw PostgREST/Postgres error into something an administrator can
 * actually act on.
 *
 * Every admin Server Action used to end with `return { error: error.message }`,
 * which surfaces things like
 * `duplicate key value violates unique constraint "printer_profiles_printer_id_key_key"`
 * or `relation "public.agents" does not exist` directly in the admin UI. For
 * the audience this app is built for - a school administrator running their
 * own deployment, not a Postgres DBA - that is indistinguishable from "it
 * broke," and it leaks internal constraint/column names to boot.
 *
 * The codes mapped below are the ones an admin can genuinely do something
 * about. Two of them deserve special mention because they are the exact
 * failure class this deployment has already hit once: 42P01/42703/PGRST204
 * all mean "the database is missing something the code expects," which in
 * practice means a migration in supabase/migrations/ was never applied to the
 * live project. That is a five-minute fix if you know that's what it is, and
 * an afternoon of confusion if the screen just says
 * `column "icon_key" does not exist`.
 *
 * Anything unmapped falls back to the caller's own plain-language sentence -
 * `error.message` is never returned to the UI.
 */

/** Structurally matches supabase-js's PostgrestError without importing it,
 *  so this stays a pure module that can be unit-tested on its own. */
export interface DatabaseErrorLike {
  code?: string | null;
  message?: string | null;
}

const SCHEMA_OUT_OF_DATE =
  "This deployment's database is missing something this page needs - usually a migration in supabase/migrations/ that was never applied to the live Supabase project. See docs/deployment.md section 1.";

const MESSAGES: Record<string, string> = {
  // 23505 unique_violation
  "23505": "Something with those exact details already exists - change what you entered, or edit the existing entry instead.",
  // 23503 foreign_key_violation
  "23503": "That refers to something that no longer exists - it may have just been deleted. Reload the page and try again.",
  // 23502 not_null_violation
  "23502": "A required value was missing. Fill in every field and try again.",
  // 23514 check_violation
  "23514": "One of the values isn't allowed here. Check the field hints and try again.",
  // 22P02 invalid_text_representation (e.g. a malformed uuid)
  "22P02": "One of the values wasn't in the format the database expects. Reload the page and try again.",
  // 42501 insufficient_privilege - almost always RLS rejecting the write
  "42501": "Your account doesn't have permission to do that. Only an organization admin can.",
  // 42P01 undefined_table / 42703 undefined_column / PGRST204 unknown column
  "42P01": SCHEMA_OUT_OF_DATE,
  "42703": SCHEMA_OUT_OF_DATE,
  PGRST204: SCHEMA_OUT_OF_DATE,
  // PGRST116: .single() matched zero rows
  PGRST116: "Nothing matched - it may have been changed or deleted by someone else. Reload the page and try again.",
  // PGRST301: the JWT expired mid-request
  PGRST301: "Your session expired while saving. Sign in again and retry.",
};

/**
 * `fallback` is the caller's own one-sentence description of what failed
 * ("Couldn't save the printer.") - always written for the admin, never
 * derived from the database.
 */
export function describeDatabaseError(error: DatabaseErrorLike | null | undefined, fallback: string): string {
  const code = error?.code?.trim();
  if (!code) return fallback;
  const mapped = MESSAGES[code];
  if (!mapped) return fallback;
  // Prefix with the caller's own context so the admin knows *which* action
  // failed, not just how - "Couldn't save the printer. Something with those
  // exact details already exists..."
  return `${fallback} ${mapped}`;
}
