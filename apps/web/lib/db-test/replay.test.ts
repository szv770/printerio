import { describe, it, expect } from "vitest";
import { createDb } from "./harness";

describe("migration replay in PGlite", () => {
  it("replays every migration", async () => {
    const db = await createDb();
    const r = await db.admin<{ n: number }>("select count(*)::int n from pg_tables where schemaname='public'");
    expect(r[0]!.n).toBeGreaterThan(15);
  }, 120_000);
});
