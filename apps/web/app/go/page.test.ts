import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({ getCurrentSession: () => getCurrentSession() }));
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));

import GoPage from "./page";

const where = async () => {
  try {
    await GoPage();
  } catch (e) {
    return (e as Error).message.replace("REDIRECT:", "");
  }
  return "no redirect";
};

beforeEach(() => vi.clearAllMocks());

describe("/go sends each person to their own home", () => {
  it("not signed in: the sign-in page", async () => {
    getCurrentSession.mockResolvedValue(null);
    expect(await where()).toBe("/login");
  });
  it("signed in without an organization: the no-access page", async () => {
    getCurrentSession.mockResolvedValue({ membership: null });
    expect(await where()).toBe("/no-access");
  });
  it("an admin or approver: the admin area", async () => {
    for (const role of ["org_admin", "approver"]) {
      getCurrentSession.mockResolvedValue({ membership: { role } });
      expect(await where()).toBe("/admin");
    }
  });
  it("everyone else: their dashboard", async () => {
    getCurrentSession.mockResolvedValue({ membership: { role: "staff" } });
    expect(await where()).toBe("/home");
  });
});
