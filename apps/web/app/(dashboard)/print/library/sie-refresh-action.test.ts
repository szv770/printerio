import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const requireSessionOrRedirect = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireSessionOrRedirect: () => requireSessionOrRedirect() }));

const state = vi.hoisted(() => ({ rateOk: true, existing: [] as string[], upserts: [] as unknown[][] }));
vi.mock("@/lib/supabase/service-role", () => ({
  createServiceRoleClient: () => ({
    rpc: async () => ({ data: state.rateOk, error: null }),
    from: () => ({
      select: async () => ({ data: state.existing.map((url) => ({ url })), error: null }),
      upsert: async (rows: unknown[]) => (state.upserts.push(rows), { error: null }),
    }),
  }),
}));
vi.mock("@/lib/library/mafteiach-fetch", () => ({ loadEntry: vi.fn(), loadLikkutVolume: vi.fn(), loadList: vi.fn() }));
const refreshSie = vi.hoisted(() => vi.fn());
vi.mock("@/lib/library/sie-refresh", async (orig) => ({ ...(await orig<typeof import("@/lib/library/sie-refresh")>()), refreshSie }));

import { refreshSieAction } from "./actions";
import { SIE_WEEKLY } from "@/lib/library/sie-weekly";

const member = (role: string, early = false) => ({ userId: "u1", membership: { organization_id: "o1", role, early_tools: early } });
const result = (over = {}) => ({ found: 111, added: 0, remaining: 0, failed: [], ...over });

beforeEach(() => {
  vi.clearAllMocks();
  state.rateOk = true;
  state.existing = [];
  state.upserts.length = 0;
  requireSessionOrRedirect.mockResolvedValue(member("org_admin"));
  refreshSie.mockResolvedValue(result());
});

describe("refreshSieAction (the admin's 'Check for new weeks')", () => {
  it("is for org admins only: a member with early tools, a staff member or no organization is refused, and nothing is fetched", async () => {
    for (const s of [member("staff", true), member("approver"), { userId: "u2", membership: null }]) {
      requireSessionOrRedirect.mockResolvedValue(s);
      const res = await refreshSieAction();
      expect(res.ok).toBe(false);
    }
    expect(refreshSie).not.toHaveBeenCalled();
  });

  it("respects a rate limit, so the button cannot be pressed in a loop", async () => {
    state.rateOk = false;
    const res = await refreshSieAction();
    expect(res).toMatchObject({ ok: false, message: expect.stringMatching(/wait a few minutes/i) });
    expect(refreshSie).not.toHaveBeenCalled();
  });

  it("treats the saved copy and everything added before as already known", async () => {
    state.existing = ["https://drive.google.com/file/d/ZZZZZZZZZZZZZZZZZZZZZZZZZ/view"];
    await refreshSieAction();
    const deps = refreshSie.mock.calls[0]![0] as { known: Set<string> };
    expect(deps.known.has(SIE_WEEKLY[0]!.url)).toBe(true);
    expect(deps.known.has("https://drive.google.com/file/d/ZZZZZZZZZZZZZZZZZZZZZZZZZ/view")).toBe(true);
    expect(deps.known.size).toBe(SIE_WEEKLY.length + 1);
  });

  it("stores the new weeks (with who added them) and says how many", async () => {
    refreshSie.mockImplementation(async (deps: { save: (rows: unknown[]) => Promise<void> }) => {
      await deps.save([{ chelek: "Alef", sefer: "Bereishis", title: "New", url: "https://drive.google.com/file/d/NNNNNNNNNNNNNNNNNNNNNNNNN/view", volume: 1, page: 9, from: 4, to: 12, pageCount: 15 }]);
      return result({ found: 112, added: 1 });
    });
    const res = await refreshSieAction();
    expect(res).toMatchObject({ ok: true, message: expect.stringMatching(/added 1 new week/i) });
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]![0]).toMatchObject({ title: "New", volume: 1, page: 9, from_page: 4, to_page: 12, page_count: 15, added_by: "u1" });
  });

  it("says plainly when there is nothing new, when more remain, when some failed, and when the page cannot be read", async () => {
    expect(await refreshSieAction()).toMatchObject({ ok: true, message: expect.stringMatching(/no new weeks/i) });
    refreshSie.mockResolvedValue(result({ added: 4, remaining: 3 }));
    expect(await refreshSieAction()).toMatchObject({ message: expect.stringMatching(/3 more.*press the button again/i) });
    refreshSie.mockResolvedValue(result({ added: 1, failed: [{ title: "Noach", reason: "not shared" }] }));
    expect(await refreshSieAction()).toMatchObject({ message: expect.stringMatching(/Noach.*not shared/i) });
    refreshSie.mockResolvedValue(result({ found: 0, problem: "The Sichos In English page looks different today." }));
    expect(await refreshSieAction()).toMatchObject({ ok: false, message: expect.stringMatching(/looks different/i) });
  });
});
