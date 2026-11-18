import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, failure, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";

// The routes build their own service-role client; tests hand them a recording fake instead of a database.
let responder: (call: FakeCall) => FakeResult = () => ok();
let fake: ReturnType<typeof fakeSupabase>;
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => fake.client }));

const createPrintJob = vi.fn();
vi.mock("@/lib/jobs/create-print-job", () => ({ createPrintJob: (...args: unknown[]) => createPrintJob(...args) }));

import { POST as resolvePOST } from "./device/resolve/route";
import { POST as eventsPOST } from "./events/route";
vi.mock("@/lib/jobs/ensure-user-code", () => ({ ensureMemberUserCode: async () => "SZV" }));
import { POST as finalizePOST } from "./jobs/finalize/route";
import { GET as statusGET } from "./jobs/[jobId]/route";
import { POST as cancelPOST } from "./jobs/[jobId]/cancel/route";

const SECRET = "s".repeat(40);
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const ORG_ID = "55555555-5555-4555-8555-555555555555";
const HASH = "a".repeat(64);
const INTAKE = `gateway-intake/${DEVICE_ID}/66666666-6666-4666-8666-666666666666.pdf`;

const device = {
  id: DEVICE_ID,
  organization_id: ORG_ID,
  user_id: USER_ID,
  name: "Pixel 8",
  device_type: "android",
  created_at: "2026-10-22T00:00:00Z",
  revoked_at: null as string | null,
  first_seen_at: null as string | null,
  last_seen_at: null,
  last_user_agent: null,
  first_job_at: null,
  first_printed_at: null,
};
const member = { organization_id: ORG_ID, user_id: USER_ID, role: "staff", department: "Math", status: "active" };

/** Answers the lookups every route makes; a test overrides pieces through `over`. */
function standardResponder(over: Partial<{ device: typeof device | null; member: typeof member | null; job: unknown; profile: unknown }> = {}) {
  const dev = "device" in over ? over.device : device;
  const mem = "member" in over ? over.member : member;
  const profile = "profile" in over ? over.profile : { id: "profile-1" };
  return (call: FakeCall): FakeResult => {
    if (call.table === "member_devices" && call.op === "select") return ok(dev);
    if (call.table === "organization_members") return ok(mem);
    if (call.table === "profiles") return ok({ display_name: "Ms. Cohen", email: "c@example.org" });
    if (call.table === "printers") return ok({ name: "MLMI" });
    if (call.table === "printer_profiles") return ok(profile);
    if (call.table === "print_jobs" && call.op === "select") return ok(over.job ?? null);
    if (call.table === "print_jobs" && call.op === "update") return ok([{ id: JOB_ID }]);
    if (call.table === "device_events" && call.op === "select") return ok([]);
    if (call.table === "storage:print-jobs" && call.op === "download") {
      return ok(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])]));
    }
    return ok();
  };
}

function use(r: (call: FakeCall) => FakeResult) {
  responder = r;
  fake = fakeSupabase((call) => responder(call));
}

function req(path: string, body?: unknown, opts: { auth?: string | null; method?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = opts.auth === undefined ? `Bearer ${SECRET}` : opts.auth;
  if (auth) headers.authorization = auth;
  return new Request(`https://printio.test${path}`, {
    method: opts.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const jobParams = { params: Promise.resolve({ jobId: JOB_ID }) };

beforeEach(() => {
  process.env.GATEWAY_SHARED_SECRET = SECRET;
  process.env.GATEWAY_BASE_DOMAIN = "szvtech.org";
  createPrintJob.mockReset();
  use(standardResponder());
});

describe("bearer authentication (every gateway route)", () => {
  const handlers: Array<[string, (r: Request) => Promise<Response>, string, unknown]> = [
    ["device/resolve", (r) => resolvePOST(r), "/api/gateway/device/resolve", { tokenHash: HASH }],
    ["events", (r) => eventsPOST(r), "/api/gateway/events", { deviceId: DEVICE_ID, type: "info" }],
    [
      "jobs/finalize",
      (r) => finalizePOST(r),
      "/api/gateway/jobs/finalize",
      { deviceId: DEVICE_ID, storagePath: INTAKE, fileName: "a.pdf", sizeBytes: 5, ipp: { attributes: {} } },
    ],
    ["jobs/[jobId] GET", (r) => statusGET(r, jobParams), `/api/gateway/jobs/${JOB_ID}?deviceId=${DEVICE_ID}`, undefined],
    ["jobs/[jobId]/cancel", (r) => cancelPOST(r, jobParams), `/api/gateway/jobs/${JOB_ID}/cancel`, { deviceId: DEVICE_ID }],
  ];

  it.each(handlers)("%s: 401 without a header, with the wrong secret, with a near miss, and without the Bearer scheme", async (_n, call, path, body) => {
    for (const auth of [null, "Bearer nope", `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, SECRET, "Basic abc"]) {
      const res = await call(req(path, body, { auth }));
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "unauthorized" });
    }
    // Rejected before any database or storage access.
    expect(fake.calls).toHaveLength(0);
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it.each(handlers)("%s: 503 (never accepts anything) when no secret is configured", async (_n, call, path, body) => {
    delete process.env.GATEWAY_SHARED_SECRET;
    const res = await call(req(path, body, { auth: "Bearer " }));
    expect(res.status).toBe(503);
    const res2 = await call(req(path, body, { auth: `Bearer ${SECRET}` }));
    expect(res2.status).toBe(503);
    expect(fake.calls).toHaveLength(0);
  });

  it("503 when the configured secret is too short to be safe", async () => {
    process.env.GATEWAY_SHARED_SECRET = "short";
    const res = await resolvePOST(req("/api/gateway/device/resolve", { tokenHash: HASH }, { auth: "Bearer short" }));
    expect(res.status).toBe(503);
  });
});

describe("POST /api/gateway/device/resolve", () => {
  it("resolves a good token hash, marks the device seen, and never returns the hash", async () => {
    const res = await resolvePOST(req("/api/gateway/device/resolve", { tokenHash: HASH }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ deviceId: DEVICE_ID, userId: USER_ID, organizationId: ORG_ID, displayName: "Ms. Cohen", deviceType: "android", printerLabel: "Printio-MLMI-SZV" });
    expect(JSON.stringify(json)).not.toContain(HASH);

    const lookup = fake.calls.find((c) => c.table === "member_devices" && c.op === "select")!;
    expect(lookup.filters).toContainEqual(["eq", "token_hash", HASH]);
    expect(lookup.columns).not.toContain("token_hash");
    const seen = fake.calls.find((c) => c.table === "member_devices" && c.op === "update")!;
    expect(seen.values).toMatchObject({ last_seen_at: expect.any(String), first_seen_at: expect.any(String) });
  });

  it("keeps first_seen_at once it is set", async () => {
    use(standardResponder({ device: { ...device, first_seen_at: "2026-10-01T00:00:00Z" } }));
    await resolvePOST(req("/api/gateway/device/resolve", { tokenHash: HASH }));
    const seen = fake.calls.find((c) => c.table === "member_devices" && c.op === "update")!;
    expect(seen.values).not.toHaveProperty("first_seen_at");
  });

  it("does not rewrite last_seen_at when it is under 5 minutes old, but does once it is older", async () => {
    const seenAt = (ageMs: number) => new Date(Date.now() - ageMs).toISOString();
    use(standardResponder({ device: { ...device, first_seen_at: seenAt(3_600_000), last_seen_at: seenAt(60_000) } as unknown as typeof device }));
    expect((await resolvePOST(req("/api/gateway/device/resolve", { tokenHash: HASH }))).status).toBe(200);
    expect(fake.calls.find((c) => c.table === "member_devices" && c.op === "update")).toBeUndefined();

    use(standardResponder({ device: { ...device, first_seen_at: seenAt(3_600_000), last_seen_at: seenAt(10 * 60_000) } as unknown as typeof device }));
    await resolvePOST(req("/api/gateway/device/resolve", { tokenHash: HASH }));
    expect(fake.calls.find((c) => c.table === "member_devices" && c.op === "update")).toBeDefined();
  });

  it("404 unknown_device, 403 revoked, 403 inactive_member", async () => {
    use(standardResponder({ device: null }));
    let res = await resolvePOST(req("/api/gateway/device/resolve", { tokenHash: HASH }));
    expect([res.status, (await res.json()).error]).toEqual([404, "unknown_device"]);

    use(standardResponder({ device: { ...device, revoked_at: "2026-10-02T00:00:00Z" } }));
    res = await resolvePOST(req("/api/gateway/device/resolve", { tokenHash: HASH }));
    expect([res.status, (await res.json()).error]).toEqual([403, "revoked"]);

    use(standardResponder({ member: { ...member, status: "disabled" } }));
    res = await resolvePOST(req("/api/gateway/device/resolve", { tokenHash: HASH }));
    expect([res.status, (await res.json()).error]).toEqual([403, "inactive_member"]);

    use(standardResponder({ member: null }));
    res = await resolvePOST(req("/api/gateway/device/resolve", { tokenHash: HASH }));
    expect([res.status, (await res.json()).error]).toEqual([403, "inactive_member"]);
  });

  it.each([["not json at all"], [{}], [{ tokenHash: "short" }], [{ tokenHash: "A".repeat(64) }], [{ tokenHash: 5 }], [[]]])("400 on bad input %j", async (body) => {
    const res = await resolvePOST(req("/api/gateway/device/resolve", body));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/invalid_/);
    expect(typeof json.message).toBe("string");
    expect(fake.calls).toHaveLength(0);
  });

  it("500 with a plain message (no database text) when the lookup fails", async () => {
    use(() => failure("relation member_devices does not exist"));
    const res = await resolvePOST(req("/api/gateway/device/resolve", { tokenHash: HASH }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("relation");
  });
});

describe("POST /api/gateway/events", () => {
  it("records the event and answers 204", async () => {
    const res = await eventsPOST(req("/api/gateway/events", { deviceId: DEVICE_ID, type: "job_received", userAgent: "Windows IPP", detail: { jobs: 1 } }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    const insert = fake.calls.find((c) => c.table === "device_events" && c.op === "insert")!;
    expect(insert.values).toMatchObject({ device_id: DEVICE_ID, type: "job_received", user_agent: "Windows IPP", detail: { jobs: 1 } });
    expect(fake.calls.some((c) => c.table === "member_devices" && c.op === "update" && "first_job_at" in (c.values as object))).toBe(true);
  });

  it("still answers 204 when the bookkeeping write fails (events never fail a print)", async () => {
    use((c) => (c.table === "device_events" ? failure() : standardResponder()(c)));
    const res = await eventsPOST(req("/api/gateway/events", { deviceId: DEVICE_ID, type: "info" }));
    expect(res.status).toBe(204);
  });

  it.each([
    [{ deviceId: DEVICE_ID, type: "made_up" }],
    [{ deviceId: "not-a-uuid", type: "info" }],
    [{ type: "info" }],
    [{ deviceId: DEVICE_ID, type: "info", detail: "text" }],
  ])("400 on bad input %j", async (body) => {
    const res = await eventsPOST(req("/api/gateway/events", body));
    expect(res.status).toBe(400);
  });

  it("never trusts the deviceId: unknown 404, revoked 403, and nothing is written", async () => {
    use(standardResponder({ device: null }));
    expect((await eventsPOST(req("/api/gateway/events", { deviceId: DEVICE_ID, type: "info" }))).status).toBe(404);
    use(standardResponder({ device: { ...device, revoked_at: "2026-10-02T00:00:00Z" } }));
    expect((await eventsPOST(req("/api/gateway/events", { deviceId: DEVICE_ID, type: "info" }))).status).toBe(403);
    expect(fake.calls.some((c) => c.op === "insert")).toBe(false);
  });
});

describe("POST /api/gateway/jobs/finalize", () => {
  const goodBody = (attributes: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    deviceId: DEVICE_ID,
    storagePath: INTAKE,
    fileName: "upload.pdf",
    sizeBytes: 5,
    ipp: { jobName: "Quarterly report", userAgent: "Windows IPP/1.0", ippVersion: "2.0", attributes },
    ...extra,
  });
  const created = (status: string, extra: Record<string, unknown> = {}) => ({
    ok: true,
    jobId: JOB_ID,
    jobNumber: "JOB-2026-000042",
    status,
    heldReason: null,
    policyReasons: [],
    ...extra,
  });
  const removed = () => fake.calls.filter((c) => c.table === "storage:print-jobs" && c.op === "remove");

  it("happy path: runs the shared pipeline as the device's member on the org's raw printer, then deletes the intake object", async () => {
    createPrintJob.mockResolvedValue(created("approved"));
    const res = await finalizePOST(req("/api/gateway/jobs/finalize", goodBody({ copies: 2, sides: "two-sided-long-edge", media: "na_letter_8.5x11in", finishings: 3 })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: JOB_ID, jobNumber: "JOB-2026-000042", status: "approved" });

    expect(createPrintJob).toHaveBeenCalledTimes(1);
    const [client, session, bytes, fileName, opts] = createPrintJob.mock.calls[0]!;
    expect(client).toBe(fake.client);
    expect(session).toEqual({ userId: USER_ID, membership: { organization_id: ORG_ID, role: "staff", department: "Math" } });
    expect(Array.from(bytes as Uint8Array)).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(fileName).toBe("Quarterly report.pdf");
    expect(opts).toMatchObject({
      printerProfileId: "profile-1",
      choices: { sides: "two", staple: "none", booklet: "none", copies: 2, pageRange: "" },
      colorMode: "bw",
      paperSize: "letter",
      source: "ipp",
      deviceId: DEVICE_ID,
      ippUserAgent: "Windows IPP/1.0",
    });
    expect(opts.forcedHeldReason).toBeUndefined();

    expect(removed()).toHaveLength(1);
    expect(removed()[0]!.values).toEqual([INTAKE]);
  });

  it("picks the printer from the DEVICE's organization: active agent, raw output, default first", async () => {
    createPrintJob.mockResolvedValue(created("approved"));
    await finalizePOST(req("/api/gateway/jobs/finalize", goodBody()));
    const q = fake.calls.find((c) => c.table === "printer_profiles")!;
    expect(q.filters).toEqual(
      expect.arrayContaining([
        ["eq", "printers.organization_id", ORG_ID],
        ["eq", "agents.status", "active"],
        ["eq", "output_mode", "raw"],
        ["order", "is_default", { ascending: false }],
      ]),
    );
  });

  it("held path: what the dialog asked for but we cannot do becomes a held job with a readable reason", async () => {
    createPrintJob.mockImplementation(async (_c, _s, _b, _n, opts) =>
      created("held", { heldReason: opts.forcedHeldReason }),
    );
    const res = await finalizePOST(req("/api/gateway/jobs/finalize", goodBody({ sides: "tumble", media: "iso_a4_210x297mm", finishings: 21 })));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("held");
    expect(json.message).toMatch(/sides setting/);
    expect(json.message).toMatch(/iso_a4_210x297mm/);
    expect(json.message).toMatch(/choose it on the website/);
    const opts = createPrintJob.mock.calls[0]![4];
    expect(opts.forcedHeldReason).toMatch(/sides setting/);
    expect(opts.choices.staple).toBe("none");
    expect(opts.choices.booklet).toBe("none");
    expect(removed()).toHaveLength(1);
  });

  it("a short-edge flip from the dialog is passed on as a flip choice and is NOT held", async () => {
    createPrintJob.mockImplementation(async (_c, _s, _b, _n, opts) => created(opts.forcedHeldReason ? "held" : "approved", { heldReason: opts.forcedHeldReason }));
    const res = await finalizePOST(req("/api/gateway/jobs/finalize", goodBody({ sides: "two-sided-short-edge" })));
    expect(res.status).toBe(200);
    expect((await res.json()).status).not.toBe("held");
    const opts = createPrintJob.mock.calls[0]![4];
    expect(opts.forcedHeldReason ?? null).toBeNull();
    expect(opts.choices).toMatchObject({ sides: "two", flip: "short" });
  });

  it("denied by policy: 200 with the state and the first policy reason", async () => {
    createPrintJob.mockResolvedValue(created("denied", { policyReasons: ["Color printing is off for students."] }));
    const res = await finalizePOST(req("/api/gateway/jobs/finalize", goodBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "denied", message: "Color printing is off for students." });
  });

  it("pending approval carries a plain message", async () => {
    createPrintJob.mockResolvedValue(created("pending_approval"));
    const json = await (await finalizePOST(req("/api/gateway/jobs/finalize", goodBody()))).json();
    expect(json).toMatchObject({ status: "pending_approval", message: expect.stringMatching(/approval/i) });
  });

  it("not a usable PDF: 422 bad_pdf, no job, intake deleted", async () => {
    createPrintJob.mockResolvedValue({ ok: false, kind: "error", code: "bad_pdf", error: "File does not look like a PDF (missing %PDF- header)." });
    const res = await finalizePOST(req("/api/gateway/jobs/finalize", goodBody()));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "bad_pdf", message: expect.stringMatching(/PDF/) });
    expect(removed()).toHaveLength(1);
  });

  it("over the upload limit is also bad_pdf (422)", async () => {
    createPrintJob.mockResolvedValue({ ok: false, kind: "error", code: "too_large", error: "File exceeds this organization's 50 MB upload limit." });
    const res = await finalizePOST(req("/api/gateway/jobs/finalize", goodBody()));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("bad_pdf");
  });

  it("a page range the document does not have: keeps the job, held, with the reason", async () => {
    createPrintJob
      .mockResolvedValueOnce({ ok: false, kind: "error", code: "invalid_page_range", error: "The document only has 3 pages." })
      .mockResolvedValueOnce(created("held", { heldReason: "x" }));
    const res = await finalizePOST(req("/api/gateway/jobs/finalize", goodBody({ "page-ranges": [50, 60] })));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("held");
    expect(createPrintJob.mock.calls[1]![4].forcedHeldReason).toMatch(/pages you chose/i);
  });

  it("quota and rate limit are reported with their own codes, and the intake is cleaned up", async () => {
    createPrintJob.mockResolvedValueOnce({ ok: false, kind: "error", code: "quota_exceeded", error: "quota" });
    let res = await finalizePOST(req("/api/gateway/jobs/finalize", goodBody()));
    expect([res.status, (await res.json()).error]).toEqual([403, "quota_exceeded"]);
    createPrintJob.mockResolvedValueOnce({ ok: false, kind: "error", code: "rate_limited", error: "slow down" });
    res = await finalizePOST(req("/api/gateway/jobs/finalize", goodBody()));
    expect([res.status, (await res.json()).error]).toEqual([429, "rate_limited"]);
    expect(removed()).toHaveLength(2);
  });

  it("temporary failures are 500 and KEEP the intake object so the gateway can retry", async () => {
    createPrintJob.mockResolvedValue({ ok: false, kind: "error", code: "insert_failed", error: "Could not create the print job." });
    const res = await finalizePOST(req("/api/gateway/jobs/finalize", goodBody()));
    expect(res.status).toBe(500);
    expect(removed()).toHaveLength(0);
  });

  it("an unexpected exception is a JSON 500, never a thrown error", async () => {
    createPrintJob.mockRejectedValue(new Error("pdf-lib exploded on object 17 0 R"));
    const res = await finalizePOST(req("/api/gateway/jobs/finalize", goodBody()));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("pdf-lib");
    expect(removed()).toHaveLength(0);
  });

  it("weird attributes never throw: they hold", async () => {
    createPrintJob.mockImplementation(async (_c, _s, _b, _n, opts) => created("held", { heldReason: opts.forcedHeldReason }));
    const res = await finalizePOST(req("/api/gateway/jobs/finalize", goodBody({ copies: { nested: true }, sides: [], media: null, "page-ranges": "x", finishings: {} })));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("held");
  });

  it("never trusts deviceId: unknown 404, revoked 403, inactive member 403; no pipeline, no storage read", async () => {
    for (const [over, status] of [
      [{ device: null }, 404],
      [{ device: { ...device, revoked_at: "2026-10-02T00:00:00Z" } }, 403],
      [{ member: { ...member, status: "disabled" } }, 403],
    ] as const) {
      use(standardResponder(over));
      const res = await finalizePOST(req("/api/gateway/jobs/finalize", goodBody()));
      expect(res.status).toBe(status);
      expect(fake.calls.some((c) => c.table === "storage:print-jobs")).toBe(false);
    }
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it("refuses an upload path outside this device's intake folder (other device, other bucket area, traversal)", async () => {
    for (const storagePath of [
      `gateway-intake/${OTHER_DEVICE_ID}/66666666-6666-4666-8666-666666666666.pdf`,
      `org/${ORG_ID}/jobs/${JOB_ID}/original.pdf`,
      `gateway-intake/${DEVICE_ID}/../${OTHER_DEVICE_ID}/x.pdf`,
      `gateway-intake/${DEVICE_ID}/`,
    ]) {
      const res = await finalizePOST(req("/api/gateway/jobs/finalize", goodBody({}, { storagePath })));
      expect(res.status).toBe(400);
    }
    expect(fake.calls).toHaveLength(0);
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it("503 no_printer when the organization has no active raw printer profile (nothing downloaded or deleted)", async () => {
    use(standardResponder({ profile: null }));
    const res = await finalizePOST(req("/api/gateway/jobs/finalize", goodBody()));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("no_printer");
    expect(createPrintJob).not.toHaveBeenCalled();
    expect(removed()).toHaveLength(0);
  });

  it("404 intake_not_found when the uploaded object is missing", async () => {
    use((c) => (c.op === "download" ? failure("Object not found") : standardResponder()(c)));
    const res = await finalizePOST(req("/api/gateway/jobs/finalize", goodBody()));
    expect(res.status).toBe(404);
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it.each([
    [{}],
    [{ deviceId: DEVICE_ID }],
    [goodBody({}, { sizeBytes: -1 })],
    [goodBody({}, { ipp: {} })],
    [goodBody({}, { ipp: { attributes: [] } })],
    [goodBody({}, { fileName: 5 })],
  ])("400 on bad input %j", async (body) => {
    const res = await finalizePOST(req("/api/gateway/jobs/finalize", body));
    expect(res.status).toBe(400);
    expect(createPrintJob).not.toHaveBeenCalled();
  });
});

describe("GET /api/gateway/jobs/<jobId>", () => {
  const url = `/api/gateway/jobs/${JOB_ID}?deviceId=${DEVICE_ID}`;

  it("returns the state, scoped to this device's IPP jobs", async () => {
    use(standardResponder({ job: { id: JOB_ID, status: "held", held_reason: "Flip on the short edge is not available.", policy_reasons: [], error_message: null } }));
    const res = await statusGET(req(url), jobParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: JOB_ID, status: "held", message: "Flip on the short edge is not available." });
    const q = fake.calls.find((c) => c.table === "print_jobs")!;
    expect(q.filters).toEqual(expect.arrayContaining([["eq", "id", JOB_ID], ["eq", "device_id", DEVICE_ID], ["eq", "source", "ipp"]]));
  });

  it("no message for a job that is simply progressing", async () => {
    use(standardResponder({ job: { id: JOB_ID, status: "printing", held_reason: null, policy_reasons: [], error_message: null } }));
    expect(await (await statusGET(req(url), jobParams)).json()).toEqual({ jobId: JOB_ID, status: "printing" });
  });

  it("404 when the job is not that device's", async () => {
    use(standardResponder({ job: null }));
    const res = await statusGET(req(url), jobParams);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("unknown_job");
  });

  it("400 without a usable deviceId, 404 for a job id that is not a uuid", async () => {
    expect((await statusGET(req(`/api/gateway/jobs/${JOB_ID}`), jobParams)).status).toBe(400);
    expect((await statusGET(req(`/api/gateway/jobs/${JOB_ID}?deviceId=nope`), jobParams)).status).toBe(400);
    expect((await statusGET(req(url), { params: Promise.resolve({ jobId: "x'; drop table print_jobs;--" }) })).status).toBe(404);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("POST /api/gateway/jobs/<jobId>/cancel", () => {
  const url = `/api/gateway/jobs/${JOB_ID}/cancel`;
  const jobRow = (status: string) => ({
    id: JOB_ID,
    status,
    organization_id: ORG_ID,
    created_by: USER_ID,
    source_pdf_pages: 3,
    copies: 2,
    estimated_printed_sides: 6,
    estimated_physical_sheets: 3,
    color_mode: "bw",
    is_test_print: false,
  });

  it.each(["held", "pending_approval", "approved"])("cancels a %s job only if it is still in that state", async (status) => {
    use(standardResponder({ job: jobRow(status) }));
    const res = await cancelPOST(req(url, { deviceId: DEVICE_ID }), jobParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "cancelled" });
    const update = fake.calls.find((c) => c.table === "print_jobs" && c.op === "update")!;
    expect(update.values).toEqual({ status: "cancelled" });
    expect(update.filters).toEqual(expect.arrayContaining([["eq", "id", JOB_ID], ["eq", "status", status]]));
    const event = fake.calls.find((c) => c.table === "print_job_events")!;
    expect(event.values).toMatchObject({ job_id: JOB_ID, event_type: "JOB_CANCELLED" });
  });

  it("releases the quota reservation for approved / pending_approval jobs, not for held ones", async () => {
    use(standardResponder({ job: jobRow("approved") }));
    await cancelPOST(req(url, { deviceId: DEVICE_ID }), jobParams);
    const rpc = fake.calls.find((c) => c.op === "rpc" && c.table === "adjust_monthly_usage")!;
    expect(rpc.values).toMatchObject({ p_mode: "release", p_organization_id: ORG_ID, p_user_id: USER_ID, p_pdf_pages: 6, p_physical_sheets: 3 });

    use(standardResponder({ job: jobRow("held") }));
    await cancelPOST(req(url, { deviceId: DEVICE_ID }), jobParams);
    expect(fake.calls.some((c) => c.op === "rpc")).toBe(false);
  });

  it("a failed quota release does not undo the cancellation", async () => {
    use((c) => (c.op === "rpc" ? failure("deadlock") : standardResponder({ job: jobRow("approved") })(c)));
    const res = await cancelPOST(req(url, { deviceId: DEVICE_ID }), jobParams);
    expect(res.status).toBe(200);
  });

  it.each(["claimed", "downloading", "printing", "completed", "cancelled", "denied"])("409 for a %s job", async (status) => {
    use(standardResponder({ job: jobRow(status) }));
    const res = await cancelPOST(req(url, { deviceId: DEVICE_ID }), jobParams);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_cancellable");
    expect(fake.calls.some((c) => c.op === "update")).toBe(false);
  });

  it("409 when the Agent claimed the job between the read and the update", async () => {
    use((c) => (c.table === "print_jobs" && c.op === "update" ? ok([]) : standardResponder({ job: jobRow("approved") })(c)));
    const res = await cancelPOST(req(url, { deviceId: DEVICE_ID }), jobParams);
    expect(res.status).toBe(409);
    expect(fake.calls.some((c) => c.op === "rpc")).toBe(false);
  });

  it("404 for someone else's job, with the lookup scoped to this device", async () => {
    use(standardResponder({ job: null }));
    const res = await cancelPOST(req(url, { deviceId: DEVICE_ID }), jobParams);
    expect(res.status).toBe(404);
    const q = fake.calls.find((c) => c.table === "print_jobs")!;
    expect(q.filters).toContainEqual(["eq", "device_id", DEVICE_ID]);
  });

  it("403 for a revoked device, 400 for a bad body", async () => {
    use(standardResponder({ device: { ...device, revoked_at: "2026-10-02T00:00:00Z" }, job: jobRow("held") }));
    expect((await cancelPOST(req(url, { deviceId: DEVICE_ID }), jobParams)).status).toBe(403);
    expect((await cancelPOST(req(url, { deviceId: "x" }), jobParams)).status).toBe(400);
  });
});
