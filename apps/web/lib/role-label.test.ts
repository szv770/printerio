import { describe, it, expect } from "vitest";
import { roleLabel } from "./role-label";

describe("roleLabel", () => {
  it("maps stored roles to the words people see", () => {
    expect(roleLabel("org_admin")).toBe("Admin");
    expect(roleLabel("approver")).toBe("Approver");
    expect(roleLabel("staff")).toBe("Staff");
    expect(roleLabel("student")).toBe("User");
  });
  it("falls back to the raw value for an unknown role", () => {
    expect(roleLabel("mystery")).toBe("mystery");
  });
});
