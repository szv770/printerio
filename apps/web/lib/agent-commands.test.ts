import { describe, expect, it, vi } from "vitest";
import { fakeSupabase, ok } from "@/test/fake-supabase";

vi.mock("server-only", () => ({}));

import { COMMAND_MAX_AGE_MS, listCommandsForAgent } from "./agent-commands";

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const rowOf = (id: string, created_at: string, status = "pending") => ({ id, command: "CHECK_FOR_UPDATE", payload: {}, status, created_at });

describe("listCommandsForAgent: stale commands", () => {
  it("does not deliver a command older than 7 days, but delivers a fresh one", async () => {
    const fake = fakeSupabase((c) => (c.op === "select" ? ok([rowOf("old", daysAgo(8)), rowOf("fresh", daysAgo(1))]) : ok()));
    const list = await listCommandsForAgent(fake.client as never, "agent-1");
    expect(list?.map((c) => c.id)).toEqual(["fresh"]);
    expect(COMMAND_MAX_AGE_MS).toBe(7 * 86_400_000);
  });

  it("only marks the delivered command as picked up; the stale one stays untouched", async () => {
    const fake = fakeSupabase((c) => (c.op === "select" ? ok([rowOf("old", daysAgo(8)), rowOf("fresh", daysAgo(1))]) : ok()));
    await listCommandsForAgent(fake.client as never, "agent-1");
    const update = fake.calls.find((c) => c.op === "update")!;
    expect(update.filters).toEqual(expect.arrayContaining([["in", "id", ["fresh"]]]));
  });

  it("also asks the database for only recent rows, so stale ones cannot fill the page", async () => {
    const fake = fakeSupabase(() => ok([]));
    await listCommandsForAgent(fake.client as never, "agent-1");
    const or = fake.calls[0]!.filters.find((f) => f[0] === "or");
    expect(String(or?.[1])).toContain("created_at.gte.");
  });
});
