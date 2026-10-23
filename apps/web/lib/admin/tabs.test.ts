import { describe, expect, it } from "vitest";
import { peopleTabs, printerTabs } from "./tabs";

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
