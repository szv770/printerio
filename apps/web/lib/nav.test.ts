import { describe, it, expect } from "vitest";
import { adminMenu, isActiveHref, memberMenu, resolveShell, activeItemHref, TOUR_ANCHORS } from "./nav";
import { routes } from "./routes";

const flat = (groups: ReturnType<typeof adminMenu>) => groups.flatMap((g) => g.items);

describe("resolveShell", () => {
  it("gives org admins and approvers the admin shell", () => {
    expect(resolveShell("org_admin")).toBe("admin");
    expect(resolveShell("approver")).toBe("admin");
  });
  it("keeps plain members, unknown roles and no role on the member shell", () => {
    expect(resolveShell("staff")).toBe("member");
    expect(resolveShell("student")).toBe("member");
    expect(resolveShell("mystery")).toBe("member");
    expect(resolveShell(null)).toBe("member");
    expect(resolveShell(undefined)).toBe("member");
  });
});

describe("adminMenu", () => {
  it("hides admin-only pages from approvers", () => {
    const hrefs = flat(adminMenu(false)).map((i) => i.href);
    expect(hrefs).not.toContain(routes.adminDevices);
    expect(hrefs).not.toContain(routes.adminAudit);
    expect(hrefs).not.toContain(routes.adminStorage);
    expect(hrefs).toContain(routes.adminApprovals);
    expect(hrefs).toContain(routes.adminUsers);
  });
  it("shows everything to org admins", () => {
    const hrefs = flat(adminMenu(true)).map((i) => i.href);
    for (const h of [routes.adminDevices, routes.adminAudit, routes.adminStorage]) {
      expect(hrefs).toContain(h);
    }
  });
  it("keeps the member pages reachable inside the admin menu, for both roles", () => {
    for (const isOrgAdmin of [true, false]) {
      const hrefs = flat(adminMenu(isOrgAdmin)).map((i) => i.href);
      for (const h of [routes.jobs, routes.usage, routes.devices, routes.profile]) {
        expect(hrefs).toContain(h);
      }
    }
  });
  it("has no duplicate hrefs", () => {
    const hrefs = flat(adminMenu(true)).map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
  it("keeps the My jobs tour anchor", () => {
    const item = flat(adminMenu(true)).find((i) => i.href === routes.jobs);
    expect(item?.tourAnchor).toBe(TOUR_ANCHORS.myJobs);
    expect(TOUR_ANCHORS.myJobs).toBe("nav-my-jobs");
  });
});

describe("memberMenu", () => {
  it("is the simple member list and has no admin pages", () => {
    const items = memberMenu();
    expect(items.map((i) => i.href)).toEqual([routes.print, routes.jobs, routes.usage, routes.devices, routes.profile]);
    expect(items.every((i) => !i.href.startsWith("/admin"))).toBe(true);
  });
  it("keeps the My jobs tour anchor", () => {
    expect(memberMenu().find((i) => i.href === routes.jobs)?.tourAnchor).toBe("nav-my-jobs");
  });
});

describe("isActiveHref", () => {
  it("matches the page itself and its children", () => {
    expect(isActiveHref(routes.jobs, "/jobs")).toBe(true);
    expect(isActiveHref(routes.jobs, "/jobs/abc-123")).toBe(true);
    expect(isActiveHref(routes.jobs, "/jobs/")).toBe(true);
  });
  it("does not match lookalike prefixes", () => {
    expect(isActiveHref(routes.jobs, "/jobsx")).toBe(false);
    expect(isActiveHref(routes.devices, "/admin/devices")).toBe(false);
    expect(isActiveHref(routes.adminDevices, "/devices")).toBe(false);
  });
  it("matches /admin exactly only when asked", () => {
    expect(isActiveHref(routes.admin, "/admin/users", true)).toBe(false);
    expect(isActiveHref(routes.admin, "/admin", true)).toBe(true);
  });
});

describe("activeItemHref", () => {
  it("marks exactly one admin item active on member pages", () => {
    const groups = adminMenu(true);
    expect(activeItemHref(groups, "/print")).toBe(routes.print);
    expect(activeItemHref(groups, "/jobs/xyz")).toBe(routes.jobs);
    expect(activeItemHref(groups, "/usage")).toBe(routes.usage);
    expect(activeItemHref(groups, "/devices")).toBe(routes.devices);
    expect(activeItemHref(groups, "/profile")).toBe(routes.profile);
  });
  it("still works on admin pages", () => {
    const groups = adminMenu(true);
    expect(activeItemHref(groups, "/admin")).toBe(routes.admin);
    expect(activeItemHref(groups, "/admin/users/u1")).toBe(routes.adminUsers);
    expect(activeItemHref(groups, "/admin/printers/setup")).toBe(routes.adminPrinters);
    expect(activeItemHref(groups, "/admin/devices")).toBe(routes.adminDevices);
  });
  it("is null where no item applies", () => {
    expect(activeItemHref(adminMenu(true), "/home")).toBeNull();
  });
});
