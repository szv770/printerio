import { describe, expect, it } from "vitest";
import { fakeSupabase, failure, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";
import { ensureMemberUserCode } from "./ensure-user-code";

const M = { organizationId: "org-1", userId: "u-1", displayName: "Sam Vogel", email: "s@x.org" };
const isOwnRead = (c: FakeCall) => c.op === "select" && c.single === "maybeSingle";
const isUsedRead = (c: FakeCall) => c.op === "select" && !c.single;
const updates = (calls: FakeCall[]) => calls.filter((c) => c.op === "update");
const codeOf = (c: FakeCall) => (c.values as { user_code: string }).user_code;

function setup(opts: { stored?: string | null; used?: string[]; update?: (c: FakeCall, n: number) => FakeResult }) {
  let n = 0;
  const fake = fakeSupabase((c) => {
    if (isOwnRead(c)) return ok({ user_code: opts.stored ?? null });
    if (isUsedRead(c)) return ok((opts.used ?? []).map((user_code) => ({ user_code })));
    if (c.op === "update") return opts.update ? opts.update(c, n++) : ok([{ user_code: codeOf(c) }]);
    return ok();
  });
  return fake;
}

describe("ensureMemberUserCode", () => {
  it("returns the stored code without writing", async () => {
    const fake = setup({ stored: "sv07" });
    expect(await ensureMemberUserCode(fake.client as never, M)).toBe("SV07");
    expect(updates(fake.calls)).toHaveLength(0);
  });

  it("generates the first free code and persists it only where user_code is still empty", async () => {
    const fake = setup({ used: ["SV", "sva"] });
    expect(await ensureMemberUserCode(fake.client as never, M)).toBe("SVM");
    const [u] = updates(fake.calls);
    expect(u!.table).toBe("organization_members");
    expect(codeOf(u!)).toBe("SVM");
    expect(u!.filters).toEqual(expect.arrayContaining([["eq", "organization_id", "org-1"], ["eq", "user_id", "u-1"], ["is", "user_code", null]]));
  });

  it("on a unique violation (someone took it meanwhile) picks the next candidate and retries", async () => {
    const fake = setup({ update: (_c, n) => (n < 2 ? { data: null, error: { message: "dup", code: "23505" } as never } : ok([{ user_code: "SVM" }])) });
    expect(await ensureMemberUserCode(fake.client as never, M)).toBe("SVM");
    expect(updates(fake.calls).map(codeOf)).toEqual(["SV", "SVA", "SVM"]);
  });

  it("if another request set a code first (no row updated) it returns that one", async () => {
    let reads = 0;
    const fake = fakeSupabase((c) => {
      if (isOwnRead(c)) return ok({ user_code: reads++ === 0 ? null : "ZZ" });
      if (isUsedRead(c)) return ok([]);
      if (c.op === "update") return ok([]);
      return ok();
    });
    expect(await ensureMemberUserCode(fake.client as never, M)).toBe("ZZ");
  });

  it("gives up with an error after bounded retries", async () => {
    const fake = setup({ update: () => ({ data: null, error: { message: "dup", code: "23505" } as never }) });
    await expect(ensureMemberUserCode(fake.client as never, M)).rejects.toThrow();
    expect(updates(fake.calls).length).toBeLessThanOrEqual(10);
  });

  it("throws on any other database error", async () => {
    const fake = setup({ update: () => failure("down") });
    await expect(ensureMemberUserCode(fake.client as never, M)).rejects.toThrow("down");
  });

  it("throws when the used-codes list cannot be read (never guesses)", async () => {
    const fake = fakeSupabase((c) => (isOwnRead(c) ? ok({ user_code: null }) : isUsedRead(c) ? failure("nope") : ok()));
    await expect(ensureMemberUserCode(fake.client as never, M)).rejects.toThrow();
    expect(updates(fake.calls)).toHaveLength(0);
  });

  it("skips the read of the member's own row when the caller already knows the stored code", async () => {
    const fake = setup({});
    expect(await ensureMemberUserCode(fake.client as never, { ...M, stored: "ab1" })).toBe("AB1");
    expect(fake.calls).toHaveLength(0);
  });
});
