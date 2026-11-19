import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";

// P2c: the phone print dialog on the print-server path. The real routes, the real intake, cancel and status code run; only the database is faked.
let fake: ReturnType<typeof fakeSupabase>;
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => fake.client }));
vi.mock("@/lib/policy/build-facts", () => ({
  evaluateJobPolicy: async () => ({ result: { action: "allow", reasons: [] }, quotaLimit: 100, adminsBypassRestrictions: false, quotaBasis: "physical_sheets", groupIds: [] }),
}));

import { POST as finalize } from "./finalize/route";
import { GET as status } from "./[jobId]/route";
import { POST as cancel } from "./[jobId]/cancel/route";

const SECRET = "s".repeat(40);
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_DEVICE = "22222222-2222-4222-8222-222222222222";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const ORG_ID = "55555555-5555-4555-8555-555555555555";
const JOB_ID = "77777777-7777-4777-8777-777777777777";
const INTAKE = `gateway-intake/${DEVICE_ID}/66666666-6666-4666-8666-666666666666.pdf`;
const device = { id: DEVICE_ID, organization_id: ORG_ID, user_id: USER_ID, name: "Pixel 8", device_type: "android", created_at: "2026-10-22T00:00:00Z", revoked_at: null, first_seen_at: null, last_seen_at: null, last_user_agent: null, first_job_at: null, first_printed_at: null };
const member = { organization_id: ORG_ID, user_id: USER_ID, role: "staff", department: "Math", status: "active" };
const profile = {
  id: "profile-1", output_mode: "raw", booklet_binding_side: "left", raw_staple_position: "top-left",
  declared_capabilities: { duplex: true, staple: true, booklet: true }, declared_paper_sizes: ["letter"], pricing: null,
  printers: { id: "printer-1", organization_id: ORG_ID },
};

let switchOn = true;
let objectSize: number | null = 5000;
let printJob: Record<string, unknown> | null = null;
let serverJob: Record<string, unknown> | null = null;
const inserted: Record<string, unknown>[] = [];

const respond = (call: FakeCall): FakeResult => {
  if (call.table === "member_devices" && call.op === "select") return ok(device);
  if (call.table === "organization_members") return ok(member);
  if (call.table === "printer_profiles") return ok(profile);
  if (call.table === "organization_settings") return ok({ prepare_via_server: switchOn, max_upload_size_bytes: 52428800, quota_basis: "physical_sheets", job_approval_expiry_hours: 72, stamp_enabled: false });
  if (call.table === "storage:print-jobs" && call.op === "list") {
    const name = INTAKE.slice(INTAKE.lastIndexOf("/") + 1);
    return ok(objectSize === null ? [] : [{ name, metadata: { size: objectSize } }]);
  }
  if (call.op === "rpc") return ok(true);
  if (call.table === "print_jobs") return call.single ? ok(printJob) : { data: null, error: null, count: 0 };
  if (call.table === "server_jobs") {
    if (call.op === "insert") { inserted.push(call.values as Record<string, unknown>); return ok(); }
    if (call.op === "update") return ok(serverJob && ["queued", "claimed"].includes(String(serverJob.status)) ? { source_path: INTAKE, organization_id: ORG_ID } : null);
    return ok(serverJob);
  }
  return ok();
};

const post = (path: string, body: unknown) =>
  new Request(`https://printio.test${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) });
const get = (jobId: string, deviceId = DEVICE_ID) =>
  new Request(`https://printio.test/api/gateway/jobs/${jobId}?deviceId=${deviceId}`, { headers: { authorization: `Bearer ${SECRET}` } });
const ctx = { params: Promise.resolve({ jobId: JOB_ID }) };
const prepareRow = (over: Record<string, unknown> = {}, deviceId = DEVICE_ID) => ({
  id: JOB_ID, status: "queued", result: null,
  params: { finish: { originalFileName: "x.pdf", options: { deviceId, source: "ipp" } } },
  ...over,
});

beforeEach(() => {
  process.env.GATEWAY_SHARED_SECRET = SECRET;
  process.env.GATEWAY_BASE_DOMAIN = "szvtech.org";
  switchOn = true; objectSize = 5000; printJob = null; serverJob = null; inserted.length = 0;
  fake = fakeSupabase((c) => respond(c));
});

describe("finalize with the switch on", () => {
  const body = { deviceId: DEVICE_ID, storagePath: INTAKE, fileName: "upload.pdf", sizeBytes: 5000, ipp: { jobName: "Android print", userAgent: "wPrint", attributes: {} } };

  it("opens nothing: records a prepare job for the phone's file and answers at once with its id and the state draft", async () => {
    const res = await finalize(post("/api/gateway/jobs/finalize", body));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ jobNumber: "Preparing", status: "draft" });
    expect(json.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.calls.some((c) => c.op === "download")).toBe(false);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ id: json.jobId, kind: "prepare_pdf", organization_id: ORG_ID, requested_by: USER_ID, source_path: INTAKE, status: "queued" });
    const options = (inserted[0]!.params as { finish: { options: Record<string, unknown> } }).finish.options;
    expect(options).toMatchObject({ source: "ipp", deviceId: DEVICE_ID, ippUserAgent: "wPrint", confirmBookletPadding: true });
  });

  it("an upload that is not there is intake_not_found (the gateway can say so), not a server error", async () => {
    objectSize = null;
    const res = await finalize(post("/api/gateway/jobs/finalize", body));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("intake_not_found");
    expect(inserted).toHaveLength(0);
  });

  it("with the switch off the old path still runs (it downloads the file)", async () => {
    switchOn = false;
    await finalize(post("/api/gateway/jobs/finalize", body));
    expect(fake.calls.some((c) => c.op === "download")).toBe(true);
    expect(inserted).toHaveLength(0);
  });
});

describe("status while the print server is preparing", () => {
  it("is draft for a waiting or claimed prepare job", async () => {
    serverJob = prepareRow();
    const res = await status(get(JOB_ID), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: JOB_ID, status: "draft" });
  });
  it("says why when the file could not be prepared", async () => {
    serverJob = prepareRow({ status: "done", result: { error: { code: "bad_pdf", message: "This file is not a PDF." } } });
    expect(await (await status(get(JOB_ID), ctx)).json()).toEqual({ jobId: JOB_ID, status: "denied", message: "This file is not a PDF." });
  });
  it("another device's prepare job is unknown", async () => {
    serverJob = prepareRow({}, OTHER_DEVICE);
    expect((await status(get(JOB_ID), ctx)).status).toBe(404);
  });
  it("no job at all is unknown", async () => {
    expect((await status(get(JOB_ID), ctx)).status).toBe(404);
  });
  it("once the print job exists it is answered from that", async () => {
    printJob = { id: JOB_ID, status: "approved", held_reason: null, policy_reasons: [], error_message: null };
    serverJob = prepareRow({ status: "done", result: { printJobId: JOB_ID } });
    expect(await (await status(get(JOB_ID), ctx)).json()).toMatchObject({ jobId: JOB_ID, status: "approved" });
  });
});

describe("cancel while the print server is preparing", () => {
  const cancelReq = () => post(`/api/gateway/jobs/${JOB_ID}/cancel`, { deviceId: DEVICE_ID });
  it("cancels the prepare job", async () => {
    serverJob = prepareRow();
    const res = await cancel(cancelReq(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "cancelled" });
    expect(fake.calls.some((c) => c.table === "server_jobs" && c.op === "update")).toBe(true);
  });
  it("cannot cancel another device's job", async () => {
    serverJob = prepareRow({}, OTHER_DEVICE);
    expect((await cancel(cancelReq(), ctx)).status).toBe(404);
    expect(fake.calls.some((c) => c.table === "server_jobs" && c.op === "update")).toBe(false);
  });
  it("a prepare job that already finished (no print job found) is not cancellable", async () => {
    serverJob = prepareRow({ status: "done", result: { printJobId: JOB_ID } });
    expect((await cancel(cancelReq(), ctx)).status).toBe(409);
  });
});
