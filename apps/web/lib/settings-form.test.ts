import { describe, expect, it } from "vitest";
import {
  actionFormFields,
  adminsSummary,
  dirtyActions,
  printingSummary,
  sectionsWithErrors,
  signInSummary,
  stampSummary,
  type SettingsValues,
} from "./settings-form";

const base: SettingsValues = {
  domains: "lecfl.com\nstaff.lecfl.com",
  joinMode: "invite_or_domain",
  domainJoinRole: "student",
  bindingSide: "left",
  adminsBypass: true,
  autoRetry: false,
  stampEnabled: true,
  stampShow: "code",
  stampStrength: "light",
};

describe("dirtyActions", () => {
  it("is empty when nothing changed", () => {
    expect(dirtyActions(base, { ...base })).toEqual([]);
  });
  it("lists only the actions whose fields changed, in save order", () => {
    const cur = { ...base, stampStrength: "strong", domains: "a.com", autoRetry: true };
    expect(dirtyActions(base, cur)).toEqual(["domains", "autoRetry", "stamp"]);
  });
  it("who-can-join fields save together with the domain list in one action", () => {
    expect(dirtyActions(base, { ...base, joinMode: "invite_only" })).toEqual(["domains"]);
    expect(dirtyActions(base, { ...base, domainJoinRole: "staff" })).toEqual(["domains"]);
  });
  it("a textarea line-ending round trip is not a change", () => {
    expect(dirtyActions(base, { ...base, domains: "lecfl.com\r\nstaff.lecfl.com" })).toEqual([]);
  });
});

describe("actionFormFields (matches what the old per-card forms submitted)", () => {
  it("checkboxes submit 'on' only when checked", () => {
    expect(actionFormFields("adminBypass", { ...base, adminsBypass: false })).toEqual({});
    expect(actionFormFields("autoRetry", { ...base, autoRetry: true })).toEqual({ autoRetryFailedPrints: "on" });
  });
  it("stamp always sends show and strength", () => {
    expect(actionFormFields("stamp", { ...base, stampEnabled: false })).toEqual({ stampShow: "code", stampStrength: "light" });
    expect(actionFormFields("stamp", base)).toEqual({ stampEnabled: "on", stampShow: "code", stampStrength: "light" });
  });
  it("binding side and domains use the original field names", () => {
    expect(actionFormFields("bindingSide", { ...base, bindingSide: "right" })).toEqual({ defaultBookletBindingSide: "right" });
    expect(actionFormFields("domains", base)).toEqual({ domains: base.domains, joinMode: "invite_or_domain", domainJoinRole: "student" });
  });
});

describe("sectionsWithErrors", () => {
  it("maps failed actions to the section that holds them", () => {
    expect([...sectionsWithErrors({ domains: "bad", stamp: "x", autoRetry: "" })].sort()).toEqual(["signin", "stamp"]);
  });
});

describe("summaries", () => {
  it("sign-in", () => {
    expect(signInSummary(base)).toBe("Invitation, or an email at lecfl.com, staff.lecfl.com");
    expect(signInSummary({ ...base, domains: "a.com, b.com, c.com, d.com" })).toBe("Invitation, or an email at a.com, b.com and 2 more");
    expect(signInSummary({ ...base, joinMode: "invite_only" })).toBe("Invitation only");
    expect(signInSummary({ ...base, domains: "" })).toBe("Invitation only (add a domain to let school emails join)");
  });
  it("printing defaults", () => {
    expect(printingSummary(base)).toBe("Booklets bind on the left. Failed prints retry: off");
    expect(printingSummary({ bindingSide: "right", autoRetry: true })).toBe("Booklets bind on the right. Failed prints retry: on");
  });
  it("stamp", () => {
    expect(stampSummary(base)).toBe("Print stamp: on, light (user code only)");
    expect(stampSummary({ ...base, stampEnabled: false })).toBe("Print stamp: off");
  });
  it("admins", () => {
    expect(adminsSummary(base)).toMatch(/skip/);
    expect(adminsSummary({ adminsBypass: false })).toMatch(/same rules/);
  });
});
