import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const requireSessionOrRedirect = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireSessionOrRedirect: () => requireSessionOrRedirect() }));
const state = vi.hoisted(() => ({ rateOk: true }));
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => ({ rpc: async () => ({ data: state.rateOk, error: null }) }) }));
const loaders = vi.hoisted(() => ({
  loadLikkutVolume: vi.fn(async () => ({ ok: true as const, page: { volumes: [], current: null, parshiyos: [] } })),
  loadList: vi.fn(async () => ({ ok: true as const, page: { years: [], entries: [] } })),
  loadEntry: vi.fn(async () => ({ ok: true as const, sections: [] })),
}));
vi.mock("@/lib/library/mafteiach-fetch", () => loaders);

import { libraryEntryAction, libraryLikkutAction, libraryListAction } from "./actions";

const member = (role: string, early = false) => ({ userId: "u1", membership: { organization_id: "o1", role, early_tools: early } });

beforeEach(() => {
  vi.clearAllMocks();
  state.rateOk = true;
  requireSessionOrRedirect.mockResolvedValue(member("org_admin"));
});

describe("library actions", () => {
  it("let an admin browse", async () => {
    expect((await libraryLikkutAction(3)).ok).toBe(true);
    expect(loaders.loadLikkutVolume).toHaveBeenCalledWith(3);
    expect((await libraryListAction("maamorim", "5711")).ok).toBe(true);
    expect(loaders.loadList).toHaveBeenCalledWith({ section: "maamorim", year: "5711" });
    expect((await libraryEntryAction("/maamorim/1")).ok).toBe(true);
    expect(loaders.loadEntry).toHaveBeenCalledWith("/maamorim/1");
  });

  it("let a member browse when an admin switched early tools on, and not otherwise", async () => {
    requireSessionOrRedirect.mockResolvedValue(member("staff", true));
    expect((await libraryLikkutAction(1)).ok).toBe(true);
    requireSessionOrRedirect.mockResolvedValue(member("staff", false));
    const res = await libraryLikkutAction(1);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/admins first/i);
    expect(loaders.loadLikkutVolume).toHaveBeenCalledTimes(1);
  });

  it("need an organization, and respect the rate limit", async () => {
    requireSessionOrRedirect.mockResolvedValue({ userId: "u2", membership: null });
    expect((await libraryEntryAction("/maamorim/1")).ok).toBe(false);
    requireSessionOrRedirect.mockResolvedValue(member("org_admin"));
    state.rateOk = false;
    const res = await libraryEntryAction("/maamorim/1");
    expect(!res.ok && res.message).toMatch(/wait a few minutes/i);
    expect(loaders.loadEntry).not.toHaveBeenCalled();
  });

  it("refuse an unknown section", async () => {
    // @ts-expect-error a client could send anything
    expect((await libraryListAction("secrets")).ok).toBe(false);
    expect(loaders.loadList).not.toHaveBeenCalled();
  });
});
