import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { fakeSupabase, failure, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";

const evaluateJobPolicy = vi.fn();
vi.mock("@/lib/policy/build-facts", () => ({ evaluateJobPolicy: (...a: unknown[]) => evaluateJobPolicy(...a) }));

import { createPrintJob, type JobOptions, type JobSession } from "./create-print-job";

const ORG = "org-1";
const USER = "user-1";
const session: JobSession = { userId: USER, membership: { organization_id: ORG, role: "staff", department: null } };

const profileRow = (over: Record<string, unknown> = {}) => ({
  id: "profile-1",
  output_mode: "raw",
  booklet_binding_side: "left",
  raw_staple_position: "top-left",
  declared_capabilities: { duplex: true, staple: true, booklet: true },
  declared_paper_sizes: ["letter"],
  pricing: null,
  printers: { id: "printer-1", organization_id: ORG },
  ...over,
});

const baseOpts = (over: Partial<JobOptions> = {}): JobOptions => ({
  printerProfileId: "profile-1",
  choices: { sides: "one", staple: "none", booklet: "none", copies: 1, pageRange: "" },
  colorMode: "bw",
  paperSize: "letter",
  punch: false,
  confirmBookletPadding: false,
  ...over,
});

let pdf3: Uint8Array;
beforeAll(async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([612, 792]);
  pdf3 = await doc.save();
});

let respond: (call: FakeCall) => FakeResult;
let fake: ReturnType<typeof fakeSupabase>;
function defaults(over: Partial<{ profile: unknown; usage: boolean; rate: boolean; insert: FakeResult; upload: FakeResult }> = {}) {
  return (call: FakeCall): FakeResult => {
    if (call.op === "rpc" && call.table === "check_rate_limit") return ok(over.rate ?? true);
    if (call.op === "rpc" && call.table === "adjust_monthly_usage") return ok(over.usage ?? true);
    if (call.table === "printer_profiles") return ok("profile" in over ? over.profile : profileRow());
    if (call.table === "organization_settings") return ok({ max_upload_size_bytes: 52428800, quota_basis: "physical_sheets", job_approval_expiry_hours: 72 });
    if (call.table === "storage:print-jobs" && call.op === "upload") return over.upload ?? ok({ path: "x" });
    if (call.table === "print_jobs" && call.op === "insert") return over.insert ?? ok({ job_number: "JOB-2026-000007" });
    return ok();
  };
}
function use(over: Parameters<typeof defaults>[0] = {}) {
  respond = defaults(over);
  fake = fakeSupabase((c) => respond(c));
}
const insertedJob = () => fake.calls.find((c) => c.table === "print_jobs" && c.op === "insert")!.values as Record<string, unknown>;
const rpcs = (name: string) => fake.calls.filter((c) => c.op === "rpc" && c.table === name);
const run = (bytes: Uint8Array = pdf3, opts: JobOptions = baseOpts(), name = "report.pdf") => createPrintJob(fake.client as never, session, bytes, name, opts);

beforeEach(() => {
  evaluateJobPolicy.mockReset();
  evaluateJobPolicy.mockResolvedValue({
    result: { action: "allow", reasons: [] },
    quotaLimit: 100,
    adminsBypassRestrictions: false,
    quotaBasis: "physical_sheets",
    groupIds: [],
  });
  use();
});

describe("createPrintJob: success", () => {
  it("returns the job (no redirect) and stores the same row the website always stored", async () => {
    const res = await run(pdf3, baseOpts({ choices: { sides: "two", staple: "none", booklet: "none", copies: 2, pageRange: "" } }));
    expect(res).toEqual({ ok: true, jobId: expect.any(String), jobNumber: "JOB-2026-000007", status: "approved", heldReason: null, policyReasons: [] });
    if (!res.ok) return;

    const row = insertedJob();
    expect(row).toMatchObject({
      id: res.jobId,
      organization_id: ORG,
      created_by: USER,
      printer_id: "printer-1",
      printer_profile_id: "profile-1",
      status: "approved",
      original_file_name: "report.pdf",
      source_pdf_pages: 3,
      copies: 2,
      color_mode: "bw",
      duplex: true,
      paper_size: "letter",
      finishing: { staple: false, booklet: false, punch: false },
      held_reason: null,
      page_range: null,
      policy_action: "allow",
      expires_at: null,
    });
    expect(row.approved_at).toEqual(expect.any(String));
    // A web job leaves the IPP columns out entirely (they default), so the insert is what it always was.
    expect(row).not.toHaveProperty("source");
    expect(row).not.toHaveProperty("device_id");
    expect(row).not.toHaveProperty("ipp_user_agent");

    const uploads = fake.calls.filter((c) => c.op === "upload").map((c) => (c.values as { path: string }).path);
    expect(uploads).toEqual([`org/${ORG}/jobs/${res.jobId}/original.pdf`]);
    expect(rpcs("check_rate_limit")[0]!.values).toMatchObject({ p_key: `print_submit:${USER}`, p_max_count: 20, p_window_seconds: 300 });
    expect(rpcs("adjust_monthly_usage")[0]!.values).toMatchObject({ p_mode: "reserve", p_user_id: USER, p_organization_id: ORG, p_limit: 100 });
    const events = fake.calls.find((c) => c.table === "print_job_events")!.values as Array<{ event_type: string; actor_type: string; actor_id: string }>;
    expect(events.map((e) => e.event_type)).toEqual(["JOB_CREATED", "PDF_UPLOADED", "PREFLIGHT_COMPLETED", "POLICY_EVALUATED", "APPROVED"]);
    expect(events.every((e) => e.actor_type === "user" && e.actor_id === USER)).toBe(true);
  });

  it("only touches the database through from()/rpc()/storage: no auth.uid() or session needed (service-role safe)", async () => {
    // fakeSupabase has no `auth` object, so any supabase.auth.* call in the pipeline would have thrown above.
    expect((fake.client as Record<string, unknown>).auth).toBeUndefined();
    const res = await run();
    expect(res.ok).toBe(true);
  });

  it("pending_approval and denied are successful creations with the policy's outcome", async () => {
    evaluateJobPolicy.mockResolvedValue({ result: { action: "require_approval", reasons: ["Needs a teacher"] }, quotaLimit: null, adminsBypassRestrictions: false, quotaBasis: "physical_sheets", groupIds: [] });
    let res = await run();
    expect(res).toMatchObject({ ok: true, status: "pending_approval", policyReasons: ["Needs a teacher"] });
    expect(insertedJob().expires_at).toEqual(expect.any(String));
    expect(rpcs("adjust_monthly_usage")).toHaveLength(1);

    use();
    evaluateJobPolicy.mockResolvedValue({ result: { action: "deny", reasons: ["No color"] }, quotaLimit: null, adminsBypassRestrictions: false, quotaBasis: "physical_sheets", groupIds: [] });
    res = await run();
    expect(res).toMatchObject({ ok: true, status: "denied", policyReasons: ["No color"] });
    expect(rpcs("adjust_monthly_usage")).toHaveLength(0); // a denied job reserves nothing
  });

  it("records an IPP job's origin on the row and in its first event", async () => {
    const res = await run(pdf3, baseOpts({ source: "ipp", deviceId: "device-1", ippUserAgent: "Windows IPP" }));
    expect(res.ok).toBe(true);
    expect(insertedJob()).toMatchObject({ source: "ipp", device_id: "device-1", ipp_user_agent: "Windows IPP" });
    const events = fake.calls.find((c) => c.table === "print_job_events")!.values as Array<{ event_type: string; metadata: unknown }>;
    expect(events[0]).toMatchObject({ event_type: "JOB_CREATED", metadata: { source: "ipp", deviceId: "device-1" } });
  });
});

describe("createPrintJob: held path", () => {
  it("forcedHeldReason creates the job as held with that reason and reserves nothing", async () => {
    const res = await run(pdf3, baseOpts({ forcedHeldReason: "Flip on the short edge is not available from the print dialog yet." }));
    expect(res).toMatchObject({ ok: true, status: "held", heldReason: "Flip on the short edge is not available from the print dialog yet.", policyReasons: [] });
    expect(insertedJob()).toMatchObject({
      status: "held",
      held_reason: "Flip on the short edge is not available from the print dialog yet.",
      policy_action: null,
      derived_file_path: null,
      approved_at: null,
    });
    expect(insertedJob().expires_at).toEqual(expect.any(String));
    expect(evaluateJobPolicy).not.toHaveBeenCalled();
    expect(rpcs("adjust_monthly_usage")).toHaveLength(0);
    const events = fake.calls.find((c) => c.table === "print_job_events")!.values as Array<{ event_type: string }>;
    expect(events.map((e) => e.event_type)).toEqual(["JOB_CREATED", "PDF_UPLOADED", "PREFLIGHT_COMPLETED"]);
  });

  it("the forced reason wins over the printer's own held reason", async () => {
    use({ profile: profileRow({ declared_capabilities: { duplex: false, staple: false, booklet: false } }) });
    const res = await run(pdf3, baseOpts({ choices: { sides: "two", staple: "none", booklet: "none", copies: 1, pageRange: "" }, forcedHeldReason: "Because I said so." }));
    expect(res).toMatchObject({ ok: true, status: "held", heldReason: "Because I said so." });
  });

  it("without a forced reason, the printer's own held logic still holds (website behaviour unchanged)", async () => {
    use({ profile: profileRow({ declared_capabilities: { duplex: false, staple: false, booklet: false } }) });
    const res = await run(pdf3, baseOpts({ choices: { sides: "two", staple: "none", booklet: "none", copies: 1, pageRange: "" } }));
    expect(res).toMatchObject({ ok: true, status: "held", heldReason: expect.stringMatching(/double-sided/) });
  });

  it("a forced hold survives a page range the document does not have: held, range dropped, both reasons kept", async () => {
    const res = await run(pdf3, baseOpts({ choices: { sides: "one", staple: "none", booklet: "none", copies: 1, pageRange: "50-60" }, forcedHeldReason: "Not available yet." }));
    expect(res).toMatchObject({ ok: true, status: "held" });
    if (!res.ok) return;
    expect(res.heldReason).toMatch(/^Not available yet\./);
    expect(res.heldReason).toMatch(/only has 3 pages/);
    expect(insertedJob().page_range).toBeNull();
  });
});

describe("createPrintJob: error path", () => {
  it("a bad range on a normal job is an inline field error (unchanged for the website)", async () => {
    const res = await run(pdf3, baseOpts({ choices: { sides: "one", staple: "none", booklet: "none", copies: 1, pageRange: "50-60" } }));
    expect(res).toMatchObject({ ok: false, kind: "error", code: "invalid_page_range", error: expect.stringMatching(/only has 3 pages/), fieldErrors: { pageRange: expect.any(String) } });
    expect(fake.calls.some((c) => c.op === "insert" || c.op === "upload")).toBe(false);
  });

  it("not a PDF: bad_pdf, nothing stored, nothing reserved", async () => {
    const res = await run(new TextEncoder().encode("hello, this is not a pdf"));
    expect(res).toMatchObject({ ok: false, kind: "error", code: "bad_pdf", error: expect.stringMatching(/PDF/) });
    expect(fake.calls.some((c) => c.op === "insert" || c.op === "upload" || c.table === "adjust_monthly_usage")).toBe(false);
  });

  it("empty and corrupt files are bad_pdf, not exceptions", async () => {
    expect(await run(new Uint8Array(0))).toMatchObject({ ok: false, code: "bad_pdf" });
    const corrupt = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj garbage");
    expect(await run(corrupt)).toMatchObject({ ok: false, code: "bad_pdf" });
  });

  it("over the organization's upload limit", async () => {
    respond = (c) => (c.table === "organization_settings" ? ok({ max_upload_size_bytes: 10, quota_basis: "physical_sheets", job_approval_expiry_hours: 72 }) : defaults()(c));
    expect(await run()).toMatchObject({ ok: false, code: "too_large", error: expect.stringMatching(/exceeds/) });
  });

  it("a printer of another organization is 'not available' (explicit check, since service role bypasses RLS)", async () => {
    use({ profile: profileRow({ printers: { id: "printer-9", organization_id: "some-other-org" } }) });
    expect(await run()).toMatchObject({ ok: false, code: "printer_unavailable", error: "Selected printer is not available." });
    expect(fake.calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("no printer chosen and a missing profile", async () => {
    expect(await run(pdf3, baseOpts({ printerProfileId: "" }))).toMatchObject({ ok: false, code: "invalid_request" });
    use({ profile: null });
    expect(await run()).toMatchObject({ ok: false, code: "printer_unavailable" });
  });

  it("too many submissions", async () => {
    use({ rate: false });
    expect(await run()).toMatchObject({ ok: false, code: "rate_limited", error: expect.stringMatching(/too quickly/) });
    expect(fake.calls.filter((c) => c.table !== "check_rate_limit")).toHaveLength(0);
  });

  it("over quota: no job row, no upload", async () => {
    use({ usage: false });
    expect(await run()).toMatchObject({ ok: false, code: "quota_exceeded", error: expect.stringMatching(/monthly print quota/) });
    expect(fake.calls.some((c) => c.op === "insert" || c.op === "upload")).toBe(false);
  });

  it("a failed insert rolls back the upload and the quota reservation, and shows no database text", async () => {
    use({ insert: failure('null value in column "x" violates not-null constraint') });
    const res = await run();
    expect(res).toMatchObject({ ok: false, code: "insert_failed", error: "Could not create the print job. Your file is still selected - submit again." });
    const removed = fake.calls.find((c) => c.op === "remove")!;
    expect((removed.values as string[])[0]).toMatch(/original\.pdf$/);
    expect(rpcs("adjust_monthly_usage").map((c) => (c.values as { p_mode: string }).p_mode)).toEqual(["reserve", "release"]);
  });

  it("a failed upload rolls back the quota reservation", async () => {
    use({ upload: failure("bucket down") });
    expect(await run()).toMatchObject({ ok: false, code: "storage_failed" });
    expect(rpcs("adjust_monthly_usage").map((c) => (c.values as { p_mode: string }).p_mode)).toEqual(["reserve", "release"]);
    expect(fake.calls.some((c) => c.table === "print_jobs")).toBe(false);
  });

  it("a booklet of a document that needs padding asks to confirm (and creates nothing)", async () => {
    const res = await run(pdf3, baseOpts({ choices: { sides: "two", staple: "none", booklet: "left", copies: 1, pageRange: "" } }));
    expect(res).toEqual({ ok: false, kind: "needs_booklet_confirm", needsBookletConfirm: { sourcePages: 3, paddedPages: 4, blankPagesAdded: 1 } });
    expect(fake.calls.some((c) => c.op === "insert" || c.op === "upload")).toBe(false);
  });

  it("a confirmed booklet is imposed, stores a derived file and succeeds", async () => {
    const res = await run(pdf3, baseOpts({ choices: { sides: "two", staple: "none", booklet: "left", copies: 1, pageRange: "" }, confirmBookletPadding: true }));
    expect(res).toMatchObject({ ok: true, status: "approved" });
    expect(insertedJob()).toMatchObject({ booklet_binding_side: "left", booklet_padding_added: 1, finishing: { staple: false, booklet: true, punch: false } });
    expect(insertedJob().derived_file_path).toEqual(expect.stringMatching(/derived\.pdf$/));
  });
});
