import { beforeEach, describe, expect, it, vi } from "vitest";

class RedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock("next/navigation", () => ({ redirect: (to: string): never => { throw new RedirectSignal(to); } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let allowed = true;
const SESSION = { userId: "admin-1", email: "a@x.org", profile: { display_name: "Admin" }, membership: { organization_id: "org1", role: "org_admin" } };
vi.mock("@/lib/auth/session", () => ({
  requireOrgRole: async () => {
    if (!allowed) throw new Error("FORBIDDEN");
    return SESSION;
  },
}));
vi.mock("@/lib/pdf/test-print", () => ({ createTestPrintPdf: async () => new Uint8Array([1, 2, 3]) }));
vi.mock("@/lib/pdf/preflight", () => ({ preflightPdf: async () => ({ ok: true, pageCount: 1, fileSizeBytes: 3 }) }));
vi.mock("@/lib/remote-commands", () => ({ issueRemoteCommand: vi.fn() }));

const profile = { id: "p1", label: "Office", agent_id: "ag1", declared_paper_sizes: ["letter"], windows_queue_name: "Q", raw_host: null, raw_port: null, pricing: null, printers: { id: "pr1", name: "Kyocera", organization_id: "org1" } };
let profileRow: unknown;
const memberWrites: string[] = [];
const member = {
  rpc: async () => ({ data: true, error: null }),
  from(table: string) {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: table === "printer_profiles" ? profileRow : table === "organizations" ? { name: "Org" } : null, error: null }),
      insert: async () => (memberWrites.push(`insert:${table}`), { error: null }),
    };
    return q;
  },
  storage: { from: () => ({ upload: async () => (memberWrites.push("upload"), { error: { message: "denied" } }) }) },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => member }));

const serviceOps: string[] = [];
let insertedJob: Record<string, unknown> | null = null;
const service = {
  from(table: string) {
    return {
      insert: async (v: Record<string, unknown>) => {
        serviceOps.push(`insert:${table}`);
        if (table === "print_jobs") insertedJob = v;
        return { error: null };
      },
    };
  },
  storage: { from: () => ({ upload: async (path: string) => (serviceOps.push(`upload:${path}`), { error: null }), remove: async () => ({ error: null }) }) },
};
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => service }));

import { sendTestPrintAction } from "./actions";

const fd = () => {
  const f = new FormData();
  f.set("printerProfileId", "p1");
  f.set("status", "completed");
  f.set("created_by", "other");
  return f;
};

beforeEach(() => {
  allowed = true;
  profileRow = profile;
  memberWrites.length = 0;
  serviceOps.length = 0;
  insertedJob = null;
});

describe("sendTestPrintAction", () => {
  it("uploads and inserts the job with the service role only, taking created_by/org from the session", async () => {
    await expect(sendTestPrintAction({}, fd())).rejects.toBeInstanceOf(RedirectSignal);
    // only the audit-log line stays on the admin's own client; nothing about the job itself
    expect(memberWrites.filter((w) => w !== "insert:audit_logs")).toEqual([]);
    expect(serviceOps.some((o) => o.startsWith("upload:org/org1/jobs/"))).toBe(true);
    expect(serviceOps).toContain("insert:print_jobs");
    expect(serviceOps).toContain("insert:print_job_events");
    expect(insertedJob).toMatchObject({ organization_id: "org1", created_by: "admin-1", status: "approved", is_test_print: true });
  });

  it("refuses a profile outside the caller's organization and writes nothing", async () => {
    profileRow = { ...profile, printers: { ...profile.printers, organization_id: "org2" } };
    expect(await sendTestPrintAction({}, fd())).toMatchObject({ error: expect.stringMatching(/isn't in your organization/i) });
    expect(serviceOps).toEqual([]);
  });

  it("is org_admin only", async () => {
    allowed = false;
    await expect(sendTestPrintAction({}, fd())).rejects.toThrow("FORBIDDEN");
    expect(serviceOps).toEqual([]);
  });
});
