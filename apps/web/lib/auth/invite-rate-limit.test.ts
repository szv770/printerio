import { describe, expect, it, vi } from "vitest";
import { checkInviteRateLimit } from "./invite-rate-limit";

function client(result: { data: boolean | null; error: { message: string } | null }) {
  return { rpc: vi.fn().mockResolvedValue(result) };
}

describe("checkInviteRateLimit", () => {
  it("blocks when over the limit", async () => {
    const c = client({ data: false, error: null });
    expect(await checkInviteRateLimit(c, { userId: "u1", ip: "1.2.3.4" })).toBe(false);
  });
  it("checks both a per-user and a per-IP key", async () => {
    const c = client({ data: true, error: null });
    expect(await checkInviteRateLimit(c, { userId: "u1", ip: "1.2.3.4" })).toBe(true);
    const keys = c.rpc.mock.calls.map((x) => x[1].p_key);
    expect(keys).toEqual(["invite_redeem:user:u1", "invite_redeem:ip:1.2.3.4"]);
  });
  it("blocks if only the IP bucket is over", async () => {
    const c = { rpc: vi.fn().mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: false, error: null }) };
    expect(await checkInviteRateLimit(c, { userId: "u1", ip: "1.2.3.4" })).toBe(false);
  });
  it("fails open on a database error (same as the other limiters)", async () => {
    const c = client({ data: null, error: { message: "boom" } });
    expect(await checkInviteRateLimit(c, { userId: "u1", ip: "x" })).toBe(true);
  });
  it("skips the user key for anonymous lookups", async () => {
    const c = client({ data: true, error: null });
    await checkInviteRateLimit(c, { ip: "9.9.9.9" });
    expect(c.rpc).toHaveBeenCalledTimes(1);
  });
});
