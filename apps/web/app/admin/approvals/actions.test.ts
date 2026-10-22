import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const SESSION = { userId: "approver-1", membership: { organization_id: "org1", role: "approver" } };
let roleAllowed = true;
const requireOrgRole = vi.fn(async (roles: string[]) => {
  if (!roleAllowed) throw new Error(`Requires one of roles: ${roles.join(", ")}`);
  return SESSION;
});
vi.mock("@/lib/auth/session", () => ({ requireOrgRole: (r: string[]) => requireOrgRole(r) }));

const adjustMonthlyUsage = vi.fn(async (..._args: unknown[]) => true);
vi.mock("@/lib/quota", async (orig) => ({ ...(await orig<typeof import("@/lib/quota")>()), adjustMonthlyUsage: (...a: unknown[]) => (adjustMonthlyUsage as (...x: unknown[]) => unknown)(...a) }));

let job: Record<string, unknown> | null;
const memberWrites: string[] = [];
const member = {
  from() {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      single: async () => (job ? { data: job, error: null } : { data: null, error: { message: "none" } }),
      maybeSingle: async () => ({ data: job, error: null }),
      update: () => (memberWrites.push("update"), q),
      insert: async () => (memberWrites.push("insert"), { error: null }),
    };
    return q;
  },
  storage: { from: () => ({ createSignedUrl: async () => (memberWrites.push("sign"), { data: null, error: { message: "denied" } }) }) },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => member }));

const writes: Array<{ table: string; op: string; values?: unknown; filters: Record<string, unknown> }> = [];
let updateRows: Array<{ id: string }> = [{ id: "j1" }];
const signed: string[] = [];
const service = {
  from(table: string) {
    const rec = { table, op: "", values: undefined as unknown, filters: {} as Record<string, unknown> };
    const q: Record<string, unknown> = {
      update: (v: unknown) => ((rec.op = "update"), (rec.values = v), q),
      insert: (v: unknown) => ((rec.op = "insert"), (rec.values = v), writes.push(rec), Promise.resolve({ error: null })),
      eq: (k: string, v: unknown) => ((rec.filters[k] = v), q),
      select: () => q,
      then: (resolve: (v: unknown) => void) => (writes.push(rec), resolve({ data: updateRows, error: null })),
    };
    return q;
  },
  storage: { from: () => ({ createSignedUrl: async (p: string) => (signed.push(p), { data: { signedUrl: "https://signed" }, error: null }) }) },
};
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => service }));

import { approveJobAction, rejectJobAction, createJobFileUrlAction } from "./actions";

const pending = (over: Record<string, unknown> = {}) => ({
  id: "j1",
  organization_id: "org1",
  created_by: "teacher-1",
  status: "pending_approval",
  original_file_path: "org/org1/jobs/j1/original.pdf",
  files_purged_at: null,
  source_pdf_pages: 3,
  copies: 1,
  estimated_printed_sides: 3,
  estimated_physical_sheets: 2,
  color_mode: "bw",
  ...over,
});
const fd = (extra: Record<string, string> = {}) => {
  const f = new FormData();
  f.set("jobId", "j1");
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
};

beforeEach(() => {
  roleAllowed = true;
  job = pending();
  writes.length = 0;
  memberWrites.length = 0;
  signed.length = 0;
  updateRows = [{ id: "j1" }];
  adjustMonthlyUsage.mockClear();
  requireOrgRole.mockClear();
});

describe("approveJobAction", () => {
  it("writes the approval with the service role, guarded on org and status, with approved_by from the session", async () => {
    expect(await approveJobAction({}, fd())).toEqual({});
    const upd = writes.find((w) => w.table === "print_jobs" && w.op === "update")!;
    expect(upd.values).toMatchObject({ status: "approved", approved_by: "approver-1" });
    expect(upd.filters).toMatchObject({ id: "j1", organization_id: "org1", status: "pending_approval" });
    expect(writes.some((w) => w.table === "approval_actions" && w.op === "insert")).toBe(true);
    expect(writes.some((w) => w.table === "print_job_events" && w.op === "insert")).toBe(true);
    expect(memberWrites).toEqual([]);
  });

  it("is approver/admin only: a plain member is refused and nothing is written", async () => {
    roleAllowed = false;
    await expect(approveJobAction({}, fd())).rejects.toThrow(/Requires one of roles: org_admin, approver/);
    expect(writes).toEqual([]);
    expect(memberWrites).toEqual([]);
  });

  it("refuses another organization's job", async () => {
    job = pending({ organization_id: "org2" });
    expect(await approveJobAction({}, fd())).toMatchObject({ error: expect.stringMatching(/different organization/i) });
    expect(writes).toEqual([]);
  });

  it("refuses a job that is not awaiting approval, and one that lost a race (no row updated)", async () => {
    job = pending({ status: "approved" });
    expect(await approveJobAction({}, fd())).toMatchObject({ error: expect.stringMatching(/no longer awaiting/i) });
    job = pending();
    updateRows = [];
    expect(await approveJobAction({}, fd())).toMatchObject({ error: expect.stringMatching(/no longer awaiting/i) });
    expect(writes.some((w) => w.table === "approval_actions")).toBe(false);
  });

  it("ignores status/approver fields in the form", async () => {
    await approveJobAction({}, fd({ status: "printing", approved_by: "someone-else", organization_id: "org9" }));
    const upd = writes.find((w) => w.table === "print_jobs")!;
    expect(upd.values).toMatchObject({ status: "approved", approved_by: "approver-1" });
    expect(upd.filters.organization_id).toBe("org1");
  });
});

describe("rejectJobAction", () => {
  it("rejects with the service role and releases the reservation once", async () => {
    expect(await rejectJobAction({}, fd({ reason: "no" }))).toEqual({});
    const upd = writes.find((w) => w.table === "print_jobs" && w.op === "update")!;
    expect(upd.values).toEqual({ status: "rejected" });
    expect(upd.filters).toMatchObject({ id: "j1", organization_id: "org1", status: "pending_approval" });
    expect(adjustMonthlyUsage).toHaveBeenCalledTimes(1);
    expect(adjustMonthlyUsage.mock.calls[0]![0]).toBe(service);
    expect(memberWrites).toEqual([]);
  });

  it("does not release quota when it lost the race (no row updated)", async () => {
    updateRows = [];
    expect(await rejectJobAction({}, fd())).toMatchObject({ error: expect.stringMatching(/no longer awaiting/i) });
    expect(adjustMonthlyUsage).not.toHaveBeenCalled();
  });

  it("is approver/admin only", async () => {
    roleAllowed = false;
    await expect(rejectJobAction({}, fd())).rejects.toThrow(/Requires one of roles/);
    expect(writes).toEqual([]);
    expect(adjustMonthlyUsage).not.toHaveBeenCalled();
  });
});

describe("createJobFileUrlAction", () => {
  it("signs the URL with the service role after the role and organization checks", async () => {
    const res = await createJobFileUrlAction("j1");
    expect(res.url).toBe("https://signed");
    expect(signed).toEqual(["org/org1/jobs/j1/original.pdf"]);
    expect(memberWrites).toEqual([]);
  });

  it("refuses plain members and other organizations' jobs before signing anything", async () => {
    job = pending({ organization_id: "org2" });
    expect(await createJobFileUrlAction("j1")).toEqual({ error: "Job not found." });
    expect(signed).toEqual([]);
    roleAllowed = false;
    await expect(createJobFileUrlAction("j1")).rejects.toThrow();
    expect(signed).toEqual([]);
  });
});
