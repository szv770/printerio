import { describe, expect, it } from "vitest";
import { canViewJobFile, jobFilePath, parseFileWhich } from "./file-access";

const ORG = "org-1";
const job = { organization_id: ORG, created_by: "u-sender", original_file_path: "org/org-1/jobs/j1/original.pdf", derived_file_path: "org/org-1/jobs/j1/derived.pdf", files_purged_at: null as string | null };

describe("canViewJobFile", () => {
  it("lets the person who sent the job view it", () => {
    expect(canViewJobFile({ userId: "u-sender", role: "staff", organizationId: ORG }, job)).toBe(true);
  });
  it("lets an org admin and an approver of the same organization view any job", () => {
    expect(canViewJobFile({ userId: "u-admin", role: "org_admin", organizationId: ORG }, job)).toBe(true);
    expect(canViewJobFile({ userId: "u-appr", role: "approver", organizationId: ORG }, job)).toBe(true);
  });
  it("does not let another member of the organization view someone else's job", () => {
    expect(canViewJobFile({ userId: "u-other", role: "staff", organizationId: ORG }, job)).toBe(false);
  });
  it("never crosses organizations, not even for an admin", () => {
    expect(canViewJobFile({ userId: "u-admin", role: "org_admin", organizationId: "org-2" }, job)).toBe(false);
    expect(canViewJobFile({ userId: "u-sender", role: "staff", organizationId: "org-2" }, job)).toBe(false);
  });
  it("does not give a platform super admin access just for being one (no organization role = no access)", () => {
    expect(canViewJobFile({ userId: "u-super", role: null, organizationId: null }, job)).toBe(false);
  });
});

describe("jobFilePath", () => {
  it("returns the original, or what was sent to the printer", () => {
    expect(jobFilePath(job, "original")).toBe(job.original_file_path);
    expect(jobFilePath(job, "sent")).toBe(job.derived_file_path);
  });
  it("falls back to the original when nothing separate was made", () => {
    expect(jobFilePath({ ...job, derived_file_path: null }, "sent")).toBe(job.original_file_path);
  });
  it("is null once the files were deleted by retention or by the owner", () => {
    expect(jobFilePath({ ...job, files_purged_at: "2026-11-01T00:00:00Z" }, "original")).toBeNull();
    expect(jobFilePath({ ...job, original_file_path: "" }, "original")).toBeNull();
  });
});

describe("parseFileWhich", () => {
  it("accepts original or sent and defaults to original", () => {
    expect(parseFileWhich("sent")).toBe("sent");
    expect(parseFileWhich("original")).toBe("original");
    expect(parseFileWhich("../../etc/passwd")).toBe("original");
    expect(parseFileWhich(null)).toBe("original");
  });
});
