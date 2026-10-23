import { describe, it, expect } from "vitest";
import { adminMenu, avatarInitial, roleLabel, openGroupIds, isActiveHref, memberMenu, resolveShell, activeItemHref, TOUR_ANCHORS } from "./nav";
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
  it("calls the log 'Activity log' everywhere (never 'Audit log')", () => {
    const labels = flat(adminMenu(true)).map((i) => i.label);
    expect(labels).toContain("Activity log");
    expect(labels).not.toContain("Audit log");
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

describe("All jobs", () => {
  it("sits in the first group next to My jobs and Approvals, for both roles", () => {
    for (const isOrgAdmin of [true, false]) {
      const hrefs = adminMenu(isOrgAdmin)[0]!.items.map((i) => i.href);
      expect(hrefs).toContain(routes.adminJobs);
      expect(hrefs).toContain(routes.jobs);
      expect(hrefs).toContain(routes.adminApprovals);
    }
    expect(routes.adminJobs).toBe("/admin/jobs");
  });
  it("is the current item on /admin/jobs, and My jobs stays current on /jobs", () => {
    const groups = adminMenu(true);
    expect(activeItemHref(groups, "/admin/jobs")).toBe(routes.adminJobs);
    expect(activeItemHref(groups, "/jobs/abc")).toBe(routes.jobs);
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

describe("openGroupIds", () => {
  const groups = adminMenu(true);
  it("always opens the untitled top block and keeps the My jobs anchor in it", () => {
    const ids = openGroupIds(groups, "/admin/reports");
    expect(ids).toContain("main");
    expect(groups.find((g) => g.id === "main")?.items.some((i) => i.tourAnchor === "nav-my-jobs")).toBe(true);
  });
  it("opens only the group that holds the current page", () => {
    expect(openGroupIds(groups, "/admin/users/u1").sort()).toEqual(["main", "people"]);
    expect(openGroupIds(groups, "/profile").sort()).toEqual(["account", "main"]);
    expect(openGroupIds(groups, "/admin/printers/setup")).toContain("printers");
  });
  it("opens just the top block when no item applies", () => {
    expect(openGroupIds(groups, "/home")).toEqual(["main"]);
  });
  it("keeps group ids unique and shows at most 10 rows while everything is folded", () => {
    const ids = groups.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    const visible = groups.filter((g) => g.alwaysOpen).flatMap((g) => g.items).length + groups.filter((g) => !g.alwaysOpen).length;
    expect(visible).toBeLessThanOrEqual(10);
  });
  it("hides admin-only pages from approvers in every group", () => {
    const hrefs = adminMenu(false).flatMap((g) => g.items.map((i) => i.href));
    for (const h of [routes.adminDevices, routes.adminAudit, routes.adminStorage]) expect(hrefs).not.toContain(h);
  });
});

describe("user chip helpers", () => {
  it("labels roles plainly", () => {
    expect(roleLabel("org_admin")).toBe("Admin");
    expect(roleLabel("approver")).toBe("Approver");
    expect(roleLabel("weird")).toBe("Member");
    expect(roleLabel(null)).toBe("Member");
  });
  it("picks an avatar initial from name, then email", () => {
    expect(avatarInitial("  dana k", "x@y.z")).toBe("D");
    expect(avatarInitial("", "sam@y.z")).toBe("S");
    expect(avatarInitial(null, null)).toBe("?");
  });
});
