import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { readStamp } from "@/test/read-stamp";
import { findActiveContent } from "@/lib/pdf/active-content";
import { fakeSupabase, failure, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";

const evaluateJobPolicy = vi.fn();
vi.mock("@/lib/policy/build-facts", () => ({ evaluateJobPolicy: (...a: unknown[]) => evaluateJobPolicy(...a) }));

// Lets one test make the stamp step hand back poisoned bytes; every other test gets the real stamp.
let stampOverride: (() => Uint8Array) | null = null;
vi.mock("@/lib/pdf/stamp", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/pdf/stamp")>();
  return { ...real, stampFirstPage: (...a: Parameters<typeof real.stampFirstPage>) => (stampOverride ? Promise.resolve(stampOverride()) : real.stampFirstPage(...a)) };
});

// The pipeline's own tests do not need pdfjs (content analysis has its own tests): no analysis = pages stay whole.
vi.mock("@/lib/pdf/content-analysis", () => ({ analyzePdfContent: async () => null }));

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
    if (call.table === "organization_settings") return ok({ max_upload_size_bytes: 52428800, quota_basis: "physical_sheets", job_approval_expiry_hours: 72, stamp_enabled: false });
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

  it("an approver's own job skips the approval step, but a denial still blocks it", async () => {
    const approver: JobSession = { userId: USER, membership: { organization_id: ORG, role: "approver", department: null } };
    const runAs = () => createPrintJob(fake.client as never, approver, pdf3, "report.pdf", baseOpts());
    evaluateJobPolicy.mockResolvedValue({ result: { action: "require_approval", reasons: ["Needs a teacher"] }, quotaLimit: null, adminsBypassRestrictions: false, quotaBasis: "physical_sheets", groupIds: [] });
    let res = await runAs();
    expect(res).toMatchObject({ ok: true, status: "approved" });
    expect(insertedJob().policy_bypassed_for_admin).toBe(true); // disclosed, like the admin bypass

    use();
    evaluateJobPolicy.mockResolvedValue({ result: { action: "deny", reasons: ["No color"] }, quotaLimit: null, adminsBypassRestrictions: false, quotaBasis: "physical_sheets", groupIds: [] });
    res = await runAs();
    expect(res).toMatchObject({ ok: true, status: "denied" });
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
    // A booklet defaults to "fill the page" and records it, so a re-print repeats it.
    expect(insertedJob().finishing).toMatchObject({ bookletFit: "fill" });
  });

  it("keeps the member's 'keep original margins' choice on the job; non-booklets store no fit", async () => {
    await run(pdf3, baseOpts({ choices: { sides: "two", staple: "none", booklet: "left", copies: 1, pageRange: "" }, confirmBookletPadding: true, bookletFit: "keep" }));
    expect(insertedJob().finishing).toMatchObject({ booklet: true, bookletFit: "keep" });
    use();
    await run(pdf3, baseOpts());
    expect(insertedJob().finishing).toEqual({ staple: false, booklet: false, punch: false });
  });

  it("a double-sided short-edge job records the flip (so the Agent sends BINDING=SHORTEDGE) and is not held; long edge records nothing", async () => {
    const res = await run(pdf3, baseOpts({ choices: { sides: "two", staple: "none", booklet: "none", copies: 1, pageRange: "", flip: "short" } }));
    expect(res).toMatchObject({ ok: true, status: "approved" });
    expect(insertedJob()).toMatchObject({ duplex: true, held_reason: null, finishing: { staple: false, booklet: false, punch: false, duplexEdge: "short" } });
    use();
    await run(pdf3, baseOpts({ choices: { sides: "two", staple: "none", booklet: "none", copies: 1, pageRange: "" } }));
    expect(insertedJob().finishing).toEqual({ staple: false, booklet: false, punch: false });
  });

  it("an 11x17 booklet is recorded on the job (finishing + paper size) so a re-print repeats it; a regular one records nothing extra", async () => {
    await run(pdf3, baseOpts({ choices: { sides: "two", staple: "none", booklet: "right", copies: 1, pageRange: "" }, confirmBookletPadding: true, bookletSheet: "tabloid" }));
    expect(insertedJob()).toMatchObject({ paper_size: "tabloid", booklet_binding_side: "right", finishing: { booklet: true, bookletSheet: "tabloid" } });
    use();
    await run(pdf3, baseOpts({ choices: { sides: "two", staple: "none", booklet: "left", copies: 1, pageRange: "" }, confirmBookletPadding: true }));
    expect(insertedJob().finishing).not.toHaveProperty("bookletSheet");
    expect(insertedJob().paper_size).not.toBe("tabloid");
    use();
    // the sheet only means something for a booklet
    await run(pdf3, baseOpts({ bookletSheet: "tabloid" }));
    expect(insertedJob().paper_size).not.toBe("tabloid");
    expect(insertedJob().finishing).toEqual({ staple: false, booklet: false, punch: false });
  });
});

describe("createPrintJob: user code stamp", () => {
  const SETTINGS = { max_upload_size_bytes: 52428800, quota_basis: "physical_sheets", job_approval_expiry_hours: 72 };
  const withStamp = (settings: Record<string, unknown>, member: unknown = { user_code: "SV42", profiles: { display_name: "Sam Vogel", email: "sam@x.org" } }) => {
    respond = (c) => {
      if (c.table === "organization_settings") return ok({ ...SETTINGS, ...settings });
      if (c.table === "organization_members") return membersResponse(c, member);
      return defaults()(c);
    };
    fake = fakeSupabase((c) => respond(c));
  };
  // The member read (single row with the profile join), the org's used codes (list) and the code write (update).
  const membersResponse = (c: FakeCall, member: unknown, usedCodes: string[] = []): FakeResult => {
    if (c.op === "update") return ok([{ user_code: (c.values as { user_code: string }).user_code }]);
    if (c.single) return ok(member);
    return ok(usedCodes.map((user_code) => ({ user_code })));
  };
  const uploadsByName = () => {
    const out: Record<string, Uint8Array> = {};
    for (const c of fake.calls.filter((c) => c.op === "upload")) {
      const v = c.values as { path: string; bytes: Uint8Array };
      out[v.path.endsWith("derived.pdf") ? "derived" : "original"] = v.bytes;
    }
    return out;
  };

  it("on (the default when the columns are absent): stamps page 1 of the derived file with the member's code, original untouched", async () => {
    withStamp({});
    const res = await run();
    expect(res.ok).toBe(true);
    const up = uploadsByName();
    expect(Buffer.from(up.original!).equals(Buffer.from(pdf3))).toBe(true);
    expect(insertedJob().derived_file_path).toEqual(expect.stringMatching(/derived\.pdf$/));
    const out = await PDFDocument.load(up.derived!);
    expect(out.getPageCount()).toBe(3);
    expect(readStamp(out, 0)?.text).toBe("SV42");
    expect(readStamp(out, 1)).toBeNull();
    expect(insertedJob().source_pdf_pages).toBe(3);
  });

  it("off: nothing is stamped and no derived file is made", async () => {
    withStamp({ stamp_enabled: false });
    expect((await run()).ok).toBe(true);
    expect(Object.keys(uploadsByName())).toEqual(["original"]);
    expect(insertedJob().derived_file_path).toBeNull();
  });

  it("a member with no stored code gets a unique persistent code from their initials, saved to organization_members", async () => {
    respond = (c) => {
      if (c.table === "organization_settings") return ok({ ...SETTINGS });
      if (c.table === "organization_members") return membersResponse(c, { user_code: null, profiles: { display_name: "Rivka Cohen", email: "r@x.org" } }, ["RC"]);
      return defaults()(c);
    };
    fake = fakeSupabase((c) => respond(c));
    expect((await run()).ok).toBe(true);
    expect(readStamp(await PDFDocument.load(uploadsByName().derived!), 0)?.text).toBe("RCI");
    const saved = fake.calls.filter((c) => c.table === "organization_members" && c.op === "update");
    expect(saved.map((c) => (c.values as { user_code: string }).user_code)).toEqual(["RCI"]);
  });

  it("uses the write client (service role) to save the code, never the member client", async () => {
    const member = fakeSupabase((c) => (c.table === "organization_settings" ? ok({ ...SETTINGS }) : c.table === "organization_members" ? ok({ user_code: null, profiles: { display_name: "Rivka Cohen", email: "r@x.org" } }) : defaults()(c)));
    const writer = fakeSupabase((c) => (c.table === "organization_members" ? membersResponse(c, null) : defaults()(c)));
    const res = await createPrintJob(member.client as never, session, pdf3, "report.pdf", baseOpts({ writeClient: writer.client as never }));
    expect(res.ok).toBe(true);
    expect(member.calls.some((c) => c.op === "update")).toBe(false);
    expect(writer.calls.some((c) => c.table === "organization_members" && c.op === "update")).toBe(true);
  });

  it("if a code cannot be saved the job still prints, unstamped (never with a guessed or duplicate code)", async () => {
    respond = (c) => {
      if (c.table === "organization_settings") return ok({ ...SETTINGS });
      if (c.table === "organization_members") return c.op === "update" ? failure("down") : membersResponse(c, { user_code: null, profiles: { display_name: "Rivka Cohen", email: "r@x.org" } });
      return defaults()(c);
    };
    fake = fakeSupabase((c) => respond(c));
    expect((await run()).ok).toBe(true);
    expect(Object.keys(uploadsByName())).toEqual(["original"]);
  });

  it("no member row at all still stamps: nameless -> U + number, saved", async () => {
    withStamp({}, null);
    expect((await run()).ok).toBe(true);
    expect(readStamp(await PDFDocument.load(uploadsByName().derived!), 0)?.text).toBe("U1");
  });

  it("'code and date' shows the code plus today's date", async () => {
    withStamp({ stamp_show: "code_date" });
    expect((await run()).ok).toBe(true);
    expect(readStamp(await PDFDocument.load(uploadsByName().derived!), 0)?.text).toMatch(/^SV42 \d{4}-\d{2}-\d{2}$/);
  });

  it("a booklet is stamped AFTER imposition: page 1 of the imposed file, page count = sheet sides", async () => {
    withStamp({});
    const doc = await PDFDocument.create();
    for (let i = 0; i < 4; i++) doc.addPage([612, 792]);
    const res = await run(await doc.save(), baseOpts({ choices: { sides: "two", staple: "none", booklet: "left", copies: 1, pageRange: "" }, confirmBookletPadding: true }));
    expect(res.ok).toBe(true);
    const out = await PDFDocument.load(uploadsByName().derived!);
    expect(out.getPageCount()).toBe(2); // 4 pages -> 2 landscape sheet sides
    const { width } = out.getPage(0).getSize();
    expect(width).toBeGreaterThan(out.getPage(0).getSize().height);
    expect(readStamp(out, 0)?.text).toBe("SV42");
    expect(readStamp(out, 1)).toBeNull();
  });

  it("with a page range, the first page of the chosen pages carries the stamp", async () => {
    withStamp({});
    const res = await run(pdf3, baseOpts({ choices: { sides: "one", staple: "none", booklet: "none", copies: 1, pageRange: "2-3" } }));
    expect(res.ok).toBe(true);
    const out = await PDFDocument.load(uploadsByName().derived!);
    expect(out.getPageCount()).toBe(2);
    expect(readStamp(out, 0)?.text).toBe("SV42");
    expect(readStamp(out, 1)).toBeNull();
  });

  it("an IPP job (same pipeline) is stamped too", async () => {
    withStamp({});
    expect((await run(pdf3, baseOpts({ source: "ipp", deviceId: "d1" }))).ok).toBe(true);
    expect(readStamp(await PDFDocument.load(uploadsByName().derived!), 0)?.text).toBe("SV42");
  });

  it("a held job prints nothing yet, so it is not stamped (it is stamped when released through the same pipeline)", async () => {
    withStamp({});
    expect((await run(pdf3, baseOpts({ forcedHeldReason: "Pick options" }))).ok).toBe(true);
    expect(Object.keys(uploadsByName())).toEqual(["original"]);
  });
});

describe("createPrintJob: separate write client (web path: member reads, service-role writes)", () => {
  const WRITE_OPS = new Set(["insert", "update", "upsert", "delete", "upload", "remove"]);
  const isWrite = (c: FakeCall) => WRITE_OPS.has(c.op) || (c.op === "rpc" && c.table === "adjust_monthly_usage");

  it("sends every write (reserve, uploads, job insert, events) to writeClient and none to the member client", async () => {
    const writer = fakeSupabase((c) => defaults()(c));
    const res = await run(pdf3, baseOpts({ writeClient: writer.client as never }));
    expect(res.ok).toBe(true);
    expect(fake.calls.filter(isWrite)).toEqual([]);
    expect(writer.calls.some((c) => c.table === "print_jobs" && c.op === "insert")).toBe(true);
    expect(writer.calls.some((c) => c.op === "upload")).toBe(true);
    expect(writer.calls.some((c) => c.table === "print_job_events" && c.op === "insert")).toBe(true);
    expect(writer.calls.some((c) => c.op === "rpc" && c.table === "adjust_monthly_usage")).toBe(true);
    // reads still use the member's own client
    expect(fake.calls.some((c) => c.table === "printer_profiles")).toBe(true);
  });

  it("takes created_by and organization_id from the session, whatever else is passed", async () => {
    const writer = fakeSupabase((c) => defaults()(c));
    await run(pdf3, { ...baseOpts({ writeClient: writer.client as never }), created_by: "evil", organization_id: "evil-org", status: "approved" } as never);
    const row = writer.calls.find((c) => c.table === "print_jobs" && c.op === "insert")!.values as Record<string, unknown>;
    expect(row).toMatchObject({ created_by: USER, organization_id: ORG });
  });

  it("rolls back (storage remove, quota release) through writeClient too", async () => {
    const writer = fakeSupabase((c) => defaults({ insert: failure("db down") })(c));
    const res = await run(pdf3, baseOpts({ writeClient: writer.client as never }));
    expect(res).toMatchObject({ ok: false, code: "insert_failed" });
    expect(fake.calls.filter(isWrite)).toEqual([]);
    expect(writer.calls.some((c) => c.op === "remove")).toBe(true);
    expect(writer.calls.filter((c) => c.op === "rpc" && c.table === "adjust_monthly_usage").map((c) => (c.values as { p_mode: string }).p_mode)).toEqual(["reserve", "release"]);
  });
});

describe("createPrintJob: PDFs with embedded attachments are sanitized, not rejected", () => {
  let withAttachment: Uint8Array;
  beforeAll(async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([612, 792]);
    await doc.attach(new Uint8Array([7, 7, 7, 7]), "x.bin", { mimeType: "application/octet-stream" });
    withAttachment = await doc.save();
  });
  const uploads = () => {
    const out: Record<string, Uint8Array> = {};
    for (const c of fake.calls.filter((c) => c.op === "upload")) {
      const v = c.values as { path: string; bytes: Uint8Array };
      out[v.path.endsWith("derived.pdf") ? "derived" : "original"] = v.bytes;
    }
    return out;
  };

  it("stores the upload as-is as the original, and a clean derived copy that the Agent will print", async () => {
    const res = await run(withAttachment);
    expect(res).toMatchObject({ ok: true, status: "approved" });
    const up = uploads();
    expect(Buffer.from(up.original!).equals(Buffer.from(withAttachment))).toBe(true);
    expect(insertedJob().derived_file_path).toEqual(expect.stringMatching(/derived\.pdf$/));
    expect(insertedJob().source_pdf_pages).toBe(3);
    expect(findActiveContent(await PDFDocument.load(up.derived!))).toEqual([]);
  });

  it("the sanitized file is what gets imposed (booklet)", async () => {
    const res = await run(withAttachment, baseOpts({ choices: { sides: "two", staple: "none", booklet: "left", copies: 1, pageRange: "" }, confirmBookletPadding: true }));
    expect(res.ok).toBe(true);
    expect(findActiveContent(await PDFDocument.load(uploads().derived!))).toEqual([]);
  });

  it("the sanitized file is what gets a page-range subset", async () => {
    const res = await run(withAttachment, baseOpts({ choices: { sides: "one", staple: "none", booklet: "none", copies: 1, pageRange: "1-2" } }));
    expect(res.ok).toBe(true);
    const out = await PDFDocument.load(uploads().derived!);
    expect(out.getPageCount()).toBe(2);
    expect(findActiveContent(out)).toEqual([]);
  });

  it("the stamp is applied to the sanitized file", async () => {
    respond = (c) => {
      if (c.table === "organization_settings") return ok({ max_upload_size_bytes: 52428800, quota_basis: "physical_sheets", job_approval_expiry_hours: 72, stamp_enabled: true });
      if (c.table === "organization_members") return ok({ user_code: "SV42", profiles: { display_name: "S", email: "s@x.org" } });
      return defaults()(c);
    };
    fake = fakeSupabase((c) => respond(c));
    const res = await run(withAttachment);
    expect(res.ok).toBe(true);
    const out = await PDFDocument.load(uploads().derived!);
    expect(readStamp(out, 0)?.text).toBe("SV42");
    expect(findActiveContent(out)).toEqual([]);
  });

  it("still fails a corrupt PDF as bad_pdf with a plain message", async () => {
    const res = await run(new TextEncoder().encode("%PDF-1.4\nnope"));
    expect(res).toMatchObject({ ok: false, code: "bad_pdf", error: expect.stringMatching(/couldn.t read/i) });
  });
});

describe("rate limit goes through the service-role (write) client (security review F3)", () => {
  it("calls check_rate_limit on writeClient, never on the member client, with the unchanged key", async () => {
    const member = fakeSupabase((c) => defaults()(c));
    const service = fakeSupabase((c) => defaults()(c));
    const res = await createPrintJob(member.client as never, session, pdf3, "r.pdf", baseOpts({ writeClient: service.client as never }));
    expect(res.ok).toBe(true);
    expect(member.calls.filter((c) => c.table === "check_rate_limit")).toHaveLength(0);
    const calls = service.calls.filter((c) => c.table === "check_rate_limit");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual({ p_key: `print_submit:${USER}`, p_max_count: 20, p_window_seconds: 300 });
  });

  it("still fails open (and carries on) when the limiter errors, and blocks when over the limit", async () => {
    const service = fakeSupabase((c) => (c.table === "check_rate_limit" ? failure("permission denied") : defaults()(c)));
    const member = fakeSupabase((c) => defaults()(c));
    const r1 = await createPrintJob(member.client as never, session, pdf3, "r.pdf", baseOpts({ writeClient: service.client as never }));
    expect(r1.ok).toBe(true);
    use({ rate: false });
    const r2 = await run();
    expect(r2).toMatchObject({ ok: false, code: "rate_limited" });
  });
});

describe("printer escape sequences never reach the derived file (security review F1)", () => {
  it("refuses a derived file that carries a UEL, before any quota is reserved or anything is stored", async () => {
    respond = (c) => {
      if (c.table === "organization_settings") return ok({ max_upload_size_bytes: 52428800, quota_basis: "physical_sheets", job_approval_expiry_hours: 72, stamp_enabled: true });
      if (c.table === "organization_members") return ok({ user_code: "SV42", profiles: { display_name: "S", email: "s@x.org" } });
      return defaults()(c);
    };
    fake = fakeSupabase((c) => respond(c));
    stampOverride = () => new TextEncoder().encode("%PDF-1.4\n\x1b%-12345X@PJL INFO ID");
    try {
      const res = await run();
      expect(res).toMatchObject({ ok: false, code: "bad_pdf", error: expect.stringMatching(/printer control codes/) });
    } finally {
      stampOverride = null;
    }
    expect(rpcs("adjust_monthly_usage")).toHaveLength(0);
    expect(fake.calls.filter((c) => c.op === "upload")).toHaveLength(0);
  });

  it("refuses an upload that carries a UEL as bad_pdf", async () => {
    const poisoned = new Uint8Array([...pdf3, ...new TextEncoder().encode("\x1b%-12345X@PJL INFO ID")]);
    expect(await run(poisoned)).toMatchObject({ ok: false, code: "bad_pdf", error: expect.stringMatching(/printer control codes/) });
  });
});
