import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { fakeSupabase, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";
import { findActiveContent } from "@/lib/pdf/active-content";

// The REAL createPrintJob + preflight run here; only the database and the policy lookup are faked.
let fake: ReturnType<typeof fakeSupabase>;
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => fake.client }));
vi.mock("@/lib/policy/build-facts", () => ({
  evaluateJobPolicy: async () => ({ result: { action: "allow", reasons: [] }, quotaLimit: 100, adminsBypassRestrictions: false, quotaBasis: "physical_sheets", groupIds: [] }),
}));

import { POST } from "./route";

const SECRET = "s".repeat(40);
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const ORG_ID = "55555555-5555-4555-8555-555555555555";
const INTAKE = `gateway-intake/${DEVICE_ID}/66666666-6666-4666-8666-666666666666.pdf`;
const device = { id: DEVICE_ID, organization_id: ORG_ID, user_id: USER_ID, name: "Pixel 8", device_type: "android", created_at: "2026-10-22T00:00:00Z", revoked_at: null, first_seen_at: null, last_seen_at: null, last_user_agent: null, first_job_at: null, first_printed_at: null };
const member = { organization_id: ORG_ID, user_id: USER_ID, role: "staff", department: "Math", status: "active" };
const profile = {
  id: "profile-1", output_mode: "raw", booklet_binding_side: "left", raw_staple_position: "top-left",
  declared_capabilities: { duplex: true, staple: true, booklet: true }, declared_paper_sizes: ["letter"], pricing: null,
  printers: { id: "printer-1", organization_id: ORG_ID },
};

let intake: Uint8Array;
const respond = (call: FakeCall): FakeResult => {
  if (call.table === "member_devices" && call.op === "select") return ok(device);
  if (call.table === "organization_members") return ok(member);
  if (call.table === "printer_profiles") return ok(profile);
  if (call.table === "organization_settings") return ok({ max_upload_size_bytes: 52428800, quota_basis: "physical_sheets", job_approval_expiry_hours: 72, stamp_enabled: false });
  if (call.table === "storage:print-jobs" && call.op === "download") return ok(new Blob([intake as BlobPart]));
  if (call.op === "rpc" && call.table === "check_rate_limit") return ok(true);
  if (call.op === "rpc" && call.table === "adjust_monthly_usage") return ok(true);
  if (call.table === "print_jobs" && call.op === "insert") return ok({ job_number: "JOB-2026-000042" });
  return ok();
};

const request = () =>
  new Request("https://printio.test/api/gateway/jobs/finalize", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ deviceId: DEVICE_ID, storagePath: INTAKE, fileName: "upload.pdf", sizeBytes: intake.byteLength, ipp: { jobName: "Android print", attributes: {} } }),
  });

beforeEach(() => {
  process.env.GATEWAY_SHARED_SECRET = SECRET;
  process.env.GATEWAY_BASE_DOMAIN = "szvtech.org";
  fake = fakeSupabase((c) => respond(c));
});

describe("POST /api/gateway/jobs/finalize with a PDF that has an embedded file", () => {
  it("returns 200, creates the job, and stores a derived file with the attachment removed", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    await doc.attach(new Uint8Array([1, 2, 3]), "x.bin", { mimeType: "application/octet-stream" });
    intake = await doc.save();

    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ jobNumber: "JOB-2026-000042", status: "approved" });
    const row = fake.calls.find((c) => c.table === "print_jobs" && c.op === "insert")!.values as Record<string, unknown>;
    expect(row.derived_file_path).toEqual(expect.stringMatching(/derived\.pdf$/));
    const derived = fake.calls.find((c) => c.op === "upload" && (c.values as { path: string }).path.endsWith("derived.pdf"))!.values as { bytes: Uint8Array };
    expect(findActiveContent(await PDFDocument.load(derived.bytes))).toEqual([]);
  });

  it("a corrupt file is still 422 bad_pdf, in plain words", async () => {
    intake = new TextEncoder().encode("%PDF-1.4\nnot really");
    const res = await POST(request());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "bad_pdf", message: expect.stringMatching(/couldn.t read/i) });
  });
});
