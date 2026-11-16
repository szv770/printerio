import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { lastChoicesFromSubmit, readPrintPreferences, saveRememberLast, writeLastChoices } from "./print-preferences";

type Row = { user_id: string; remember_last: boolean; last_choices: unknown };
type Mode = "ok" | "missing-table" | "throws";

/** A tiny stand-in for the supabase client over ONE table: just the calls print-preferences.ts makes, applying the filters like the database would. */
function fakeClient(rows: Row[], mode: Mode = "ok") {
  const calls: { op: string; values?: Record<string, unknown>; filters: [string, unknown][] }[] = [];
  const missing = { message: 'relation "public.user_print_preferences" does not exist', code: "42P01" };
  const client = {
    from(table: string) {
      expect(table).toBe("user_print_preferences");
      if (mode === "throws") throw new Error("network down");
      const q = (op: string, values?: Record<string, unknown>) => {
        const call = { op, values, filters: [] as [string, unknown][] };
        calls.push(call);
        const matches = () => rows.filter((r) => call.filters.every(([k, v]) => (r as Record<string, unknown>)[k] === v));
        const builder = {
          eq(k: string, v: unknown) {
            call.filters.push([k, v]);
            return builder;
          },
          async maybeSingle() {
            if (mode === "missing-table") return { data: null, error: missing };
            const m = matches();
            return { data: m[0] ? { remember_last: m[0].remember_last, last_choices: m[0].last_choices } : null, error: null };
          },
          then(resolve: (v: unknown) => void) {
            if (mode === "missing-table") return resolve({ data: null, error: missing });
            if (op === "update") for (const r of matches()) Object.assign(r, values);
            resolve({ data: null, error: null });
          },
        };
        return builder;
      };
      return {
        select: () => q("select"),
        update: (v: Record<string, unknown>) => q("update", v),
        async upsert(v: Record<string, unknown>) {
          calls.push({ op: "upsert", values: v, filters: [] });
          if (mode === "missing-table") return { error: missing };
          const existing = rows.find((r) => r.user_id === v.user_id);
          if (existing) Object.assign(existing, v);
          else rows.push({ remember_last: false, last_choices: null, ...v } as Row);
          return { error: null };
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, calls };
}

const U = "user-1";

describe("readPrintPreferences", () => {
  it("is OFF by default: no row means remember_last false and nothing remembered", async () => {
    const { client } = fakeClient([]);
    expect(await readPrintPreferences(client, U)).toEqual({ available: true, rememberLast: false, remembered: null });
  });

  it("a row with remember_last false hands over nothing, even if choices are stored", async () => {
    const { client } = fakeClient([{ user_id: U, remember_last: false, last_choices: { copies: 5 } }]);
    expect(await readPrintPreferences(client, U)).toEqual({ available: true, rememberLast: false, remembered: null });
  });

  it("with it ON hands over the stored choices, validated, and never the booklet", async () => {
    const { client } = fakeClient([{ user_id: U, remember_last: true, last_choices: { copies: 5, sides: "two", booklet: "left", paperSize: "legal", rubbish: 1 } }]);
    const p = await readPrintPreferences(client, U);
    expect(p.rememberLast).toBe(true);
    expect(p.remembered).toEqual({ copies: 5, paperSize: "legal" }); // booklet gone, and its sides value with it
  });

  it("invalid stored data is ignored (setting on, nothing remembered)", async () => {
    for (const junk of ["text", 42, ["a"], { copies: -3, sides: "x" }, null]) {
      const { client } = fakeClient([{ user_id: U, remember_last: true, last_choices: junk }]);
      expect(await readPrintPreferences(client, U)).toEqual({ available: true, rememberLast: true, remembered: {} });
    }
  });

  it("a missing table (migration not applied) means setting off and not available, without throwing", async () => {
    const { client } = fakeClient([], "missing-table");
    expect(await readPrintPreferences(client, U)).toEqual({ available: false, rememberLast: false, remembered: null });
  });

  it("any thrown error also means setting off", async () => {
    const { client } = fakeClient([], "throws");
    await expect(readPrintPreferences(client, U)).resolves.toEqual({ available: false, rememberLast: false, remembered: null });
  });
});

describe("writeLastChoices", () => {
  it("writes only when remember_last is on", async () => {
    const on: Row = { user_id: U, remember_last: true, last_choices: null };
    const off: Row = { user_id: "user-2", remember_last: false, last_choices: null };
    const { client, calls } = fakeClient([on, off]);
    await writeLastChoices(client, U, { copies: 3 });
    await writeLastChoices(client, "user-2", { copies: 9 });
    await writeLastChoices(client, "user-without-a-row", { copies: 9 });
    expect(on.last_choices).toEqual({ copies: 3 });
    expect(off.last_choices).toBeNull();
    expect(calls.every((c) => c.filters.some(([k, v]) => k === "remember_last" && v === true))).toBe(true);
  });

  it("never throws, whatever goes wrong", async () => {
    for (const mode of ["missing-table", "throws"] as const) {
      await expect(writeLastChoices(fakeClient([], mode).client, U, { copies: 3 })).resolves.toBeUndefined();
    }
  });
});

describe("saveRememberLast", () => {
  it("turns it on, keeping any stored choices", async () => {
    const row: Row = { user_id: U, remember_last: false, last_choices: { copies: 2 } };
    const { client } = fakeClient([row]);
    expect(await saveRememberLast(client, U, true)).toBe(true);
    expect(row).toMatchObject({ remember_last: true, last_choices: { copies: 2 } });
  });

  it("creates the row when there is none, and turning it off forgets the stored choices", async () => {
    const rows: Row[] = [];
    const { client } = fakeClient(rows);
    expect(await saveRememberLast(client, U, true)).toBe(true);
    expect(rows).toHaveLength(1);
    rows[0]!.last_choices = { copies: 2 };
    expect(await saveRememberLast(client, U, false)).toBe(true);
    expect(rows[0]).toMatchObject({ remember_last: false, last_choices: null });
  });

  it("reports false (does not throw) when the table is missing or the call fails", async () => {
    expect(await saveRememberLast(fakeClient([], "missing-table").client, U, true)).toBe(false);
    expect(await saveRememberLast(fakeClient([], "throws").client, U, true)).toBe(false);
  });
});

describe("lastChoicesFromSubmit", () => {
  it("keeps the form's choices and drops anything that is not a valid value", () => {
    expect(
      lastChoicesFromSubmit({ printerProfileId: "p1", sides: "two", staple: "top-left", booklet: "none", copies: 3, colorMode: "color", paperSize: "legal", punch: true, bookletFit: "keep", bookletSheet: "tabloid" }),
    ).toEqual({ profileId: "p1", sides: "two", staple: "top-left", booklet: "none", copies: 3, colorMode: "color", paperSize: "legal", punch: true, bookletFit: "keep", bookletSheet: "tabloid" });
    expect(lastChoicesFromSubmit({ printerProfileId: "", sides: "x", staple: "profile", booklet: "profile", copies: 3, colorMode: "x", paperSize: "legal", punch: false, bookletFit: "x", bookletSheet: "x" })).toEqual({ copies: 3, paperSize: "legal", punch: false });
  });
});
