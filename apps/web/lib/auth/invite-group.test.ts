import { describe, expect, it } from "vitest";
import { checkInviteGroup } from "./invite-group";

describe("checkInviteGroup", () => {
  it("is fine with no group", () => {
    expect(checkInviteGroup({ inviteOrgId: "o1", groupId: null, groupOrgId: null })).toEqual({ ok: true, groupId: null });
  });
  it("is fine when the group exists in the same org", () => {
    expect(checkInviteGroup({ inviteOrgId: "o1", groupId: "g1", groupOrgId: "o1" })).toEqual({ ok: true, groupId: "g1" });
  });
  it("skips (does not fail) a group that was deleted", () => {
    expect(checkInviteGroup({ inviteOrgId: "o1", groupId: "g1", groupOrgId: null })).toEqual({ ok: true, groupId: null });
  });
  it("refuses a group from another org", () => {
    expect(checkInviteGroup({ inviteOrgId: "o1", groupId: "g1", groupOrgId: "o2" })).toEqual({ ok: false });
  });
});
