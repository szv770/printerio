import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const getCurrentSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({ getCurrentSession: () => getCurrentSession() }));
const lookupInvite = vi.fn();
vi.mock("@/lib/auth/invite-lookup", () => ({ lookupInvite: (...a: unknown[]) => lookupInvite(...a) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./JoinCard", () => ({ JoinCard: () => null }));
vi.mock("./InviteEntry", () => ({ InviteEntry: () => null }));

import JoinPage from "./page";
import { InviteEntry } from "./InviteEntry";
import { JoinCard } from "./JoinCard";

const run = (code?: string) => JoinPage({ searchParams: Promise.resolve({ code }) });

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentSession.mockResolvedValue(null);
  lookupInvite.mockResolvedValue({ state: "active", orgName: "School" });
});

describe("/join", () => {
  it("with no code (home page 'I have an invite') asks for the link or code, and never looks an invite up", async () => {
    for (const code of [undefined, "", "   "]) {
      const el = (await run(code)) as ReactElement;
      expect(el.type).toBe(InviteEntry);
    }
    expect(lookupInvite).not.toHaveBeenCalled();
  });

  it("with a code, shows the normal join card", async () => {
    const el = (await run("a1b2c3d4e5f6")) as ReactElement;
    expect(el.type).toBe(JoinCard);
    expect(lookupInvite).toHaveBeenCalledTimes(1);
  });

  it("signed in without an organization and no code: straight to the page that has the invite box", async () => {
    getCurrentSession.mockResolvedValue({ membership: null });
    await expect(run(undefined)).rejects.toThrow("REDIRECT:/no-access");
  });
});
