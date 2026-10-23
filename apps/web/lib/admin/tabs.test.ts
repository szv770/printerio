import { describe, expect, it } from "vitest";
import { peopleTabs, printerTabs, reportTabs, rulesTabs } from "./tabs";

describe("peopleTabs", () => {
  it("is Users, Groups, Invites for an admin, with only the current one active", () => {
    const tabs = peopleTabs("groups", true);
    expect(tabs.map((t) => t.label)).toEqual(["Users", "Groups", "Invites"]);
    expect(tabs.map((t) => t.href)).toEqual(["/admin/users", "/admin/groups", "/admin/invites"]);
    expect(tabs.filter((t) => t.active).map((t) => t.label)).toEqual(["Groups"]);
  });
  it("hides Invites from approvers", () => {
    expect(peopleTabs("users", false).map((t) => t.label)).toEqual(["Users", "Groups"]);
  });
});

describe("printerTabs", () => {
  it("is Printers, Print servers, User devices for an admin", () => {
    const tabs = printerTabs("agents", true);
    expect(tabs.map((t) => t.label)).toEqual(["Printers", "Print servers", "User devices"]);
    expect(tabs.map((t) => t.href)).toEqual(["/admin/printers", "/admin/agents", "/admin/devices"]);
    expect(tabs.find((t) => t.active)?.label).toBe("Print servers");
  });
  it("hides User devices from approvers", () => {
    expect(printerTabs("printers", false).map((t) => t.label)).toEqual(["Printers", "Print servers"]);
  });
});

describe("rulesTabs", () => {
  it("is Print rules | Monthly limits", () => {
    const tabs = rulesTabs("quotas");
    expect(tabs.map((t) => t.label)).toEqual(["Print rules", "Monthly limits"]);
    expect(tabs.map((t) => t.href)).toEqual(["/admin/policies", "/admin/quotas"]);
    expect(tabs.find((t) => t.active)?.label).toBe("Monthly limits");
  });
});

describe("reportTabs", () => {
  it("is Usage | Activity log for an admin", () => {
    const tabs = reportTabs("audit", true);
    expect(tabs.map((t) => t.label)).toEqual(["Usage", "Activity log"]);
    expect(tabs.map((t) => t.href)).toEqual(["/admin/reports", "/admin/audit"]);
    expect(tabs.find((t) => t.active)?.label).toBe("Activity log");
  });
  it("hides the activity log from approvers", () => {
    expect(reportTabs("usage", false).map((t) => t.label)).toEqual(["Usage"]);
  });
});
