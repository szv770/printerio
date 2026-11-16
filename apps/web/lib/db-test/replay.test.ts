import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { createDb } from "./harness";

describe("migration replay in PGlite", () => {
  it("replays every migration", async () => {
    const db = await createDb();
    const r = await db.admin<{ n: number }>("select count(*)::int n from pg_tables where schemaname='public'");
    expect(r[0]!.n).toBeGreaterThan(15);
  }, 120_000);

  it("0056_user_print_preferences is re-runnable (a second run changes and breaks nothing)", async () => {
    const db = await createDb();
    const sql = readFileSync(path.resolve(__dirname, "../../../../supabase/migrations/0056_user_print_preferences.sql"), "utf8");
    await db.pg.exec(sql);
    const pol = await db.admin<{ n: number }>("select count(*)::int n from pg_policies where schemaname='public' and tablename='user_print_preferences'");
    expect(pol[0]!.n).toBe(3);
  }, 120_000);
});
