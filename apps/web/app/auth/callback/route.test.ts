import { beforeEach, describe, expect, it, vi } from "vitest";

const exchangeCodeForSession = vi.fn();
const verifyOtp = vi.fn();
const signOut = vi.fn();
const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession, verifyOtp, signOut }, rpc }),
}));

const eq = vi.fn();
const update = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ update }));
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => ({ from }) }));

const hasActiveMembership = vi.fn();
const tryJoinByDomain = vi.fn();
vi.mock("@/lib/auth/domain-join", () => ({
  hasActiveMembership: (...a: unknown[]) => hasActiveMembership(...a),
  tryJoinByDomain: (...a: unknown[]) => tryJoinByDomain(...a),
}));

const maybeBootstrapOrganization = vi.fn();
vi.mock("@/lib/auth/bootstrap", () => ({ maybeBootstrapOrganization: (...a: unknown[]) => maybeBootstrapOrganization(...a) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const redeemInvitation = vi.fn();
vi.mock("@/lib/auth/invitations", () => ({ redeemInvitation: (...a: unknown[]) => redeemInvitation(...a) }));

import { GET } from "./route";

const ORIGIN = "https://printio.test";
const emailUser = {
  id: "u1",
  email: "a@school.org",
  identities: [{ provider: "email", last_sign_in_at: "2026-01-01T00:00:00Z" }],
};
const googleUser = {
  id: "u2",
  email: "g@school.org",
  identities: [{ provider: "google", last_sign_in_at: "2026-01-01T00:00:00Z" }],
};

function call(query: string, headers?: Record<string, string>) {
  return GET(new Request(`${ORIGIN}/auth/callback?${query}`, { headers }));
}
function location(res: Response) {
  return new URL(res.headers.get("location")!);
}

beforeEach(() => {
  vi.clearAllMocks();
  eq.mockResolvedValue({ error: null });
  rpc.mockResolvedValue({ data: true, error: null });
  hasActiveMembership.mockResolvedValue(true);
  tryJoinByDomain.mockResolvedValue(null);
  maybeBootstrapOrganization.mockResolvedValue(undefined);
  redeemInvitation.mockResolvedValue({ ok: true, organizationId: "o1", role: "staff" });
  exchangeCodeForSession.mockResolvedValue({ data: { user: googleUser }, error: null });
  verifyOtp.mockResolvedValue({ data: { user: emailUser }, error: null });
});

describe("auth callback: code (Google PKCE) path", () => {
  it("exchanges the code, stamps, redirects home", async () => {
    const res = await call("code=abc");
    expect(exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(maybeBootstrapOrganization).toHaveBeenCalledWith("u2", "g@school.org");
    expect(from).toHaveBeenCalledWith("profiles");
    expect(location(res).pathname).toBe("/");
  });

  it("redirects home (unchanged) when the exchange fails", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: { user: null }, error: new Error("bad") });
    const res = await call("code=abc");
    expect(location(res).pathname).toBe("/");
    expect(from).not.toHaveBeenCalled();
  });
});

describe("auth callback: token_hash (cross-browser magic link) path", () => {
  it.each(["email", "magiclink"])("verifies the otp (type=%s) and runs the same post-login steps", async (type) => {
    const res = await call(`token_hash=th1&type=${type}`);
    expect(verifyOtp).toHaveBeenCalledWith({ type, token_hash: "th1" });
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(maybeBootstrapOrganization).toHaveBeenCalledWith("u1", "a@school.org");
    expect(from).toHaveBeenCalledWith("profiles");
    expect(eq).toHaveBeenCalledWith("id", "u1");
    expect(location(res).pathname).toBe("/");
  });

  it("no longer calls the old domain-gate RPCs (superseded by join_mode)", async () => {
    await call("token_hash=th1&type=email");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an existing member is never sent through the join rule", async () => {
    const res = await call("token_hash=th1&type=email");
    expect(tryJoinByDomain).not.toHaveBeenCalled();
    expect(location(res).pathname).toBe("/");
  });

  it("a non-member whose domain is allowed joins and lands home", async () => {
    hasActiveMembership.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    tryJoinByDomain.mockResolvedValue("o1");
    const res = await call("token_hash=th1&type=email");
    expect(tryJoinByDomain).toHaveBeenCalledWith("u1");
    expect(location(res).pathname).toBe("/");
  });

  it("a non-member with no invite and no allowed domain stays signed in and sees the friendly invite page", async () => {
    hasActiveMembership.mockResolvedValue(false);
    const res = await call("token_hash=th1&type=email");
    const url = location(res);
    expect(signOut).not.toHaveBeenCalled();
    expect(url.pathname).toBe("/no-access");
    expect(url.searchParams.get("reason")).toBe("invite_needed");
    expect(from).toHaveBeenCalledWith("profiles"); // reauth stamped so the page keeps the session
  });

  it("fails closed: a join error means no membership, never an accidental home redirect", async () => {
    hasActiveMembership.mockResolvedValue(false);
    tryJoinByDomain.mockResolvedValue(null);
    const res = await call("code=abc");
    expect(location(res).pathname).toBe("/no-access");
  });

  it.each(["recovery", "signup", "invite", "email_change", ""])("rejects type=%s without calling verifyOtp", async (type) => {
    const res = await call(`token_hash=th1&type=${type}`);
    expect(verifyOtp).not.toHaveBeenCalled();
    const url = location(res);
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("reason")).toBe("link_invalid");
  });

  it("redirects to login with an error flag when verifyOtp fails", async () => {
    verifyOtp.mockResolvedValue({ data: { user: null }, error: new Error("expired") });
    const res = await call("token_hash=th1&type=email");
    const url = location(res);
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("reason")).toBe("link_invalid");
    expect(from).not.toHaveBeenCalled();
  });
});

describe("auth callback: invite link carried through sign-in", () => {
  it("redeems the invite from ?invite= after sign-in and lands home", async () => {
    const res = await call("token_hash=th1&type=email&invite=a1b2c3d4e5f6", { "x-forwarded-for": "5.6.7.8" });
    expect(redeemInvitation).toHaveBeenCalledWith("a1b2c3d4e5f6", "u1", "a@school.org", { ip: "5.6.7.8" });
    expect(location(res).pathname).toBe("/");
  });

  it("falls back to the printio_invite cookie", async () => {
    await call("token_hash=th1&type=email", { cookie: "printio_invite=cafe1234beef" });
    expect(redeemInvitation).toHaveBeenCalledWith("cafe1234beef", "u1", "a@school.org", expect.anything());
  });

  it("does nothing when there is no invite", async () => {
    await call("token_hash=th1&type=email");
    expect(redeemInvitation).not.toHaveBeenCalled();
  });

  it("ignores a garbage invite value", async () => {
    await call("token_hash=th1&type=email&invite=bad%20code!");
    expect(redeemInvitation).not.toHaveBeenCalled();
  });

  it("sends the person to the code screen with a reason when redeeming fails", async () => {
    redeemInvitation.mockResolvedValue({ ok: false, reason: "expired" });
    const res = await call("token_hash=th1&type=email&invite=a1b2c3d4e5f6");
    const loc = location(res);
    expect(loc.pathname).toBe("/no-access");
    expect(loc.searchParams.get("code")).toBe("a1b2c3d4e5f6");
    expect(loc.searchParams.get("invite_error")).toBe("expired");
  });

  it("an invited outsider (any email domain) gets in: invite is redeemed before any domain rule", async () => {
    hasActiveMembership.mockResolvedValue(true); // membership exists after redeem
    const res = await call("token_hash=th1&type=email&invite=a1b2c3d4e5f6");
    expect(redeemInvitation).toHaveBeenCalled();
    expect(location(res).pathname).toBe("/");
  });

  it("treats already_member as success", async () => {
    redeemInvitation.mockResolvedValue({ ok: false, reason: "already_member" });
    const res = await call("token_hash=th1&type=email&invite=a1b2c3d4e5f6");
    expect(location(res).pathname).toBe("/");
  });
});
