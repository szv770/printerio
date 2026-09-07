import { describe, it, expect } from "vitest";
import { describeDatabaseError } from "./action-errors";

const FALLBACK = "Couldn't save the printer.";

describe("describeDatabaseError", () => {
  it("returns the caller's fallback when there is no error object", () => {
    expect(describeDatabaseError(null, FALLBACK)).toBe(FALLBACK);
    expect(describeDatabaseError(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it("returns the caller's fallback for an unmapped code", () => {
    expect(describeDatabaseError({ code: "XX000", message: "internal error" }, FALLBACK)).toBe(FALLBACK);
  });

  it("returns the caller's fallback when the error carries no code", () => {
    expect(describeDatabaseError({ message: "something went wrong" }, FALLBACK)).toBe(FALLBACK);
  });

  it("never leaks the raw database message", () => {
    const raw = 'duplicate key value violates unique constraint "printer_profiles_printer_id_key_key"';
    const result = describeDatabaseError({ code: "23505", message: raw }, FALLBACK);
    expect(result).not.toContain(raw);
    expect(result).not.toContain("constraint");
  });

  it("explains a unique violation in plain language, keeping the caller's context", () => {
    const result = describeDatabaseError({ code: "23505" }, FALLBACK);
    expect(result.startsWith(FALLBACK)).toBe(true);
    expect(result).toContain("already exists");
  });

  it("points a missing-table error at the unapplied migration, not at Postgres", () => {
    const result = describeDatabaseError({ code: "42P01", message: 'relation "public.agents" does not exist' }, FALLBACK);
    expect(result).toContain("supabase/migrations/");
    expect(result).toContain("docs/deployment.md");
  });

  it("treats a missing column and an unknown-column schema-cache miss the same way", () => {
    const undefinedColumn = describeDatabaseError({ code: "42703" }, FALLBACK);
    const schemaCacheMiss = describeDatabaseError({ code: "PGRST204" }, FALLBACK);
    expect(undefinedColumn).toBe(schemaCacheMiss);
  });

  it("explains an RLS rejection as a permissions problem", () => {
    expect(describeDatabaseError({ code: "42501" }, FALLBACK)).toContain("permission");
  });

  it("tolerates a code with surrounding whitespace", () => {
    expect(describeDatabaseError({ code: " 23505 " }, FALLBACK)).toContain("already exists");
  });
});
