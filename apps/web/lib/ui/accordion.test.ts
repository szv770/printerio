import { describe, expect, it } from "vitest";
import { COLLAPSIBLE_OPEN_EVENT, groupKey, resolveInitialOpen, shouldCloseOnOtherOpen } from "./accordion";

describe("groupKey", () => {
  it("is one group per page for top-level sections", () => {
    expect(groupKey("/admin/settings", null)).toBe(groupKey("/admin/settings", null));
    expect(groupKey("/admin/settings", null)).not.toBe(groupKey("/admin/users", null));
  });
  it("gives sections nested inside another section their own group, so opening a child never closes its parent", () => {
    expect(groupKey("/x", "parent")).not.toBe(groupKey("/x", null));
    expect(groupKey("/x", "a")).not.toBe(groupKey("/x", "b"));
  });
});

describe("resolveInitialOpen: a page always starts closed unless told otherwise", () => {
  const base = { id: "stamp", defaultOpen: false, forceOpen: false, hash: "" };
  it("closed by default (nothing is remembered from earlier visits)", () => {
    expect(resolveInitialOpen(base)).toBe(false);
  });
  it("opens for defaultOpen, forceOpen and a matching #hash", () => {
    expect(resolveInitialOpen({ ...base, defaultOpen: true })).toBe(true);
    expect(resolveInitialOpen({ ...base, forceOpen: true })).toBe(true);
    expect(resolveInitialOpen({ ...base, hash: "#stamp" })).toBe(true);
    expect(resolveInitialOpen({ ...base, hash: "#other" })).toBe(false);
  });
});

describe("shouldCloseOnOtherOpen (accordion rule)", () => {
  const g = groupKey("/admin/settings", null);
  const base = { selfId: "a", openedId: "b", selfGroup: g, openedGroup: g, forceOpen: false, independent: false };
  it("closes when a different section in the same group opens", () => {
    expect(shouldCloseOnOtherOpen(base)).toBe(true);
  });
  it("ignores itself", () => {
    expect(shouldCloseOnOtherOpen({ ...base, openedId: "a" })).toBe(false);
  });
  it("ignores sections in another group (another page, or a nested group)", () => {
    expect(shouldCloseOnOtherOpen({ ...base, openedGroup: groupKey("/admin/users", null) })).toBe(false);
    expect(shouldCloseOnOtherOpen({ ...base, openedGroup: groupKey("/admin/settings", "a") })).toBe(false);
  });
  it("never closes a section that is open because something needs attention (forceOpen)", () => {
    expect(shouldCloseOnOtherOpen({ ...base, forceOpen: true })).toBe(false);
  });
  it("lets a section opt out (independent)", () => {
    expect(shouldCloseOnOtherOpen({ ...base, independent: true })).toBe(false);
  });
});

describe("event name", () => {
  it("is stable", () => {
    expect(COLLAPSIBLE_OPEN_EVENT).toBe("printio:collapsible-open");
  });
});
