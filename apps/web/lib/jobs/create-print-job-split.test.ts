import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { fakeSupabase, failure, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";

vi.setConfig({ testTimeout: 30_000 });
const evaluateJobPolicy = vi.fn();
vi.mock("@/lib/policy/build-facts", () => ({ evaluateJobPolicy: (...a: unknown[]) => evaluateJobPolicy(...a) }));
vi.mock("@printio/pdf/content-analysis", () => ({ analyzePdfContent: async () => null }));

import { preparePdf } from "@printio/pdf/prepare";
import { checkSubmitLimits, createPrintJob, finishPrintJob, resolveJobPlan, type JobOptions, type JobSession, type PreparedForFinish } from "./create-print-job";

/**
 * createPrintJob is now three parts run in sequence: resolveJobPlan (decisions, no PDF work), preparePdf (the PDF work), finishPrintJob (policy, quota,
 * storage, insert). These tests pin each part on its own, because the print-server path will run them in different places
 * (docs/PREPARE-JOBS-DESIGN.md, plan P2b). The big createPrintJob suite still covers the whole.
 */
const ORG = "org-1";
const session: JobSession = { userId: "user-1", membership: { organization_id: ORG, role: "staff", department: null } };
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

let fake: ReturnType<typeof fakeSupabase>;
function use(over: Partial<{ profile: unknown; rate: boolean; openJobs: number; move: FakeResult }> = {}) {
  fake = fakeSupabase((call: FakeCall): FakeResult => {
    if (call.op === "rpc" && call.table === "check_rate_limit") return ok(over.rate ?? true);
    if (call.op === "rpc" && call.table === "adjust_monthly_usage") return ok(true);
    if (call.table === "printer_profiles") return ok("profile" in over ? over.profile : profileRow());
    if (call.table === "organization_settings") return ok({ max_upload_size_bytes: 52428800, quota_basis: "physical_sheets", job_approval_expiry_hours: 72, stamp_enabled: false });
    if (call.table === "storage:print-jobs" && call.op === "upload") return ok({ path: "x" });
    if (call.table === "storage:print-jobs" && call.op === "move") return over.move ?? ok({ message: "Successfully moved" });
    if (call.table === "print_jobs" && call.op === "select") return { data: null, error: null, count: over.openJobs ?? 0 };
    if (call.table === "print_jobs" && call.op === "insert") return ok({ job_number: "JOB-2026-000007" });
    return ok();
  });
}
const writes = () => fake.calls.filter((c) => c.table === "storage:print-jobs" || c.table === "print_events" || (c.table === "print_jobs" && c.op !== "select") || c.table === "adjust_monthly_usage" || c.table === "print_job_events");

beforeEach(() => {
  evaluateJobPolicy.mockReset();
  evaluateJobPolicy.mockResolvedValue({ result: { action: "allow", reasons: [] }, quotaLimit: 100, adminsBypassRestrictions: false, quotaBasis: "physical_sheets", groupIds: [] });
  use();
});

describe("resolveJobPlan (decisions only: no PDF work, nothing stored)", () => {
  it("decides what the choices mean for this printer and carries the organization's limits", async () => {
    const r = await resolveJobPlan(fake.client as never, session, pdf3.byteLength, baseOpts());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toMatchObject({
      organizationId: ORG,
      duplex: false,
      staple: false,
      booklet: false,
      punch: false,
      copies: 1,
      heldReason: null,
      maxUploadBytes: 52428800,
      quotaBasis: "physical_sheets",
      approvalExpiryHours: 72,
      source: "web",
    });
    expect(r.plan.printerProfile.id).toBe("profile-1");
    expect(writes()).toHaveLength(0);
  });

  it("a booklet choice becomes a booklet plan with the printer's binding side", async () => {
    const r = await resolveJobPlan(fake.client as never, session, pdf3.byteLength, baseOpts({ choices: { sides: "two", staple: "none", booklet: "right", copies: 2, pageRange: "" } }));
    expect(r.ok && r.plan).toMatchObject({ booklet: true, bindingSide: "right", copies: 2 });
  });

  it("a choice this printer cannot honour becomes a held reason, not an error", async () => {
    use({ profile: profileRow({ declared_capabilities: { duplex: true, staple: false, booklet: true } }) });
    const r = await resolveJobPlan(fake.client as never, session, pdf3.byteLength, baseOpts({ choices: { sides: "one", staple: "top-left", booklet: "none", copies: 1, pageRange: "" } }));
    expect(r.ok && r.plan.heldReason).toBeTruthy();
  });

  it("a hold forced by the caller wins", async () => {
    const r = await resolveJobPlan(fake.client as never, session, pdf3.byteLength, baseOpts({ forcedHeldReason: "Use the website for this." }));
    expect(r.ok && r.plan.heldReason).toBe("Use the website for this.");
  });

  it("refuses inline: no printer, too large, no printer chosen", async () => {
    use({ profile: null });
    expect(await resolveJobPlan(fake.client as never, session, 10, baseOpts())).toMatchObject({ ok: false, result: { ok: false, code: "printer_unavailable" } });
    use();
    expect(await resolveJobPlan(fake.client as never, session, 60 * 1024 * 1024, baseOpts())).toMatchObject({ ok: false, result: { code: "too_large" } });
    expect(await resolveJobPlan(fake.client as never, session, 10, baseOpts({ printerProfileId: "" }))).toMatchObject({ ok: false, result: { code: "invalid_request" } });
  });
});

describe("checkSubmitLimits (the per-person limits, counted once per submit)", () => {
  it("lets a normal submit through, and counts it against the rate limit exactly once", async () => {
    expect(await checkSubmitLimits(fake.client as never, session)).toBeNull();
    expect(fake.calls.filter((c) => c.op === "rpc" && c.table === "check_rate_limit")).toHaveLength(1);
  });
  it("refuses too many submits in a short time", async () => {
    use({ rate: false });
    expect(await checkSubmitLimits(fake.client as never, session)).toMatchObject({ ok: false, code: "rate_limited" });
  });
  it("refuses a person who already has 10 jobs waiting or printing", async () => {
    use({ openJobs: 10 });
    const r = await checkSubmitLimits(fake.client as never, session);
    expect(r).toMatchObject({ ok: false, code: "rate_limited" });
    if (r && !r.ok && r.kind === "error") expect(r.error).toMatch(/10 jobs/);
  });
  it("createPrintJob still checks the limits BEFORE looking anything else up (and resolveJobPlan no longer counts them a second time)", async () => {
    use({ rate: false });
    const r = await createPrintJob(fake.client as never, session, pdf3, "r.pdf", baseOpts());
    expect(r).toMatchObject({ ok: false, code: "rate_limited" });
    expect(fake.calls.some((c) => c.table === "printer_profiles")).toBe(false);
    use();
    await resolveJobPlan(fake.client as never, session, 10, baseOpts());
    expect(fake.calls.some((c) => c.table === "check_rate_limit")).toBe(false);
  });
});

describe("finishPrintJob (policy, quota, storage, insert) from a plan and a prepared result", () => {
  const prepared = (over: Partial<PreparedForFinish> = {}): PreparedForFinish => ({
    ok: true,
    held: false,
    heldReason: null,
    derivedBytes: null,
    effectivePageCount: 3,
    blankPagesAdded: 0,
    sourcePages: 3,
    pageRangeText: null,
    fileSizeBytes: 1234,
    pictureCopy: false,
    ...over,
  });
  async function plan() {
    const r = await resolveJobPlan(fake.client as never, session, pdf3.byteLength, baseOpts());
    if (!r.ok) throw new Error("plan failed");
    return r.plan;
  }

  it("evaluates the rules, reserves quota once, stores the original and inserts an approved job", async () => {
    const p = await plan();
    const res = await finishPrintJob(fake.client as never, session, pdf3, "report.pdf", baseOpts(), p, prepared());
    expect(res).toMatchObject({ ok: true, jobNumber: "JOB-2026-000007", status: "approved", heldReason: null });
    expect(evaluateJobPolicy).toHaveBeenCalledOnce();
    expect(fake.calls.filter((c) => c.op === "rpc" && c.table === "adjust_monthly_usage")).toHaveLength(1);
    const uploads = fake.calls.filter((c) => c.op === "upload").map((c) => (c.values as { path: string }).path);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatch(/original\.pdf$/);
    const row = fake.calls.find((c) => c.table === "print_jobs" && c.op === "insert")!.values as Record<string, unknown>;
    expect(row).toMatchObject({ status: "approved", source_pdf_pages: 3, file_size_bytes: 1234, derived_file_path: null, original_file_name: "report.pdf" });
  });

  it("a held result is stored held: no rules, no quota, no derived file", async () => {
    const p = await plan();
    const res = await finishPrintJob(fake.client as never, session, pdf3, "report.pdf", baseOpts(), p, prepared({ held: true, heldReason: "Choose a binding side." }));
    expect(res).toMatchObject({ ok: true, status: "held", heldReason: "Choose a binding side." });
    expect(evaluateJobPolicy).not.toHaveBeenCalled();
    expect(fake.calls.some((c) => c.op === "rpc" && c.table === "adjust_monthly_usage")).toBe(false);
  });

  it("the sheet limit is enforced on the real page count (so a long file is refused after preparing)", async () => {
    const p = await plan();
    const res = await finishPrintJob(fake.client as never, session, pdf3, "report.pdf", baseOpts(), p, prepared({ effectivePageCount: 500, sourcePages: 500 }));
    expect(res).toMatchObject({ ok: false, code: "too_large" });
    expect(fake.calls.some((c) => c.op === "upload")).toBe(false);
  });

  it("a derived file is stored next to the original and recorded on the job", async () => {
    const p = await plan();
    const res = await finishPrintJob(fake.client as never, session, pdf3, "report.pdf", baseOpts(), p, prepared({ derivedBytes: new Uint8Array([1, 2, 3]) }));
    expect(res.ok).toBe(true);
    const row = fake.calls.find((c) => c.table === "print_jobs" && c.op === "insert")!.values as Record<string, unknown>;
    expect(row.derived_file_path).toMatch(/derived\.pdf$/);
    expect(fake.calls.filter((c) => c.op === "upload")).toHaveLength(2);
  });
});

describe("finishPrintJob with files already in storage (the print-server path)", () => {
  const prepared = (over: Partial<PreparedForFinish> = {}): PreparedForFinish => ({
    ok: true, held: false, heldReason: null, derivedBytes: null, effectivePageCount: 3, blankPagesAdded: 0, sourcePages: 3, pageRangeText: null, fileSizeBytes: 1234, pictureCopy: false, ...over,
  });
  const JOB = "11111111-1111-4111-8111-111111111111";
  const stored = (derived: string | null = null) => ({ jobId: JOB, originalPath: `gateway-intake/user-1/${JOB}.pdf`, derivedPath: derived });
  async function plan() {
    const r = await resolveJobPlan(fake.client as never, session, 100, baseOpts());
    if (!r.ok) throw new Error("plan failed");
    return r.plan;
  }

  it("moves the original to its usual path instead of uploading, and the job gets the prepare job's id", async () => {
    const res = await finishPrintJob(fake.client as never, session, null, "r.pdf", baseOpts(), await plan(), prepared(), stored());
    expect(res).toMatchObject({ ok: true, jobId: JOB, status: "approved" });
    const moves = fake.calls.filter((c) => c.op === "move").map((c) => c.values as { from: string; to: string });
    expect(moves).toEqual([{ from: `gateway-intake/user-1/${JOB}.pdf`, to: `org/${ORG}/jobs/${JOB}/original.pdf` }]);
    expect(fake.calls.some((c) => c.op === "upload")).toBe(false);
    const row = fake.calls.find((c) => c.table === "print_jobs" && c.op === "insert")!.values as Record<string, unknown>;
    expect(row).toMatchObject({ id: JOB, original_file_path: `org/${ORG}/jobs/${JOB}/original.pdf`, derived_file_path: null });
  });

  it("a prepared file is moved too, and recorded as the derived file", async () => {
    const res = await finishPrintJob(fake.client as never, session, null, "r.pdf", baseOpts(), await plan(), prepared(), stored(`prepared/${ORG}/${JOB}/abc.pdf`));
    expect(res.ok).toBe(true);
    const moves = fake.calls.filter((c) => c.op === "move").map((c) => c.values as { from: string; to: string });
    expect(moves).toContainEqual({ from: `prepared/${ORG}/${JOB}/abc.pdf`, to: `org/${ORG}/jobs/${JOB}/derived.pdf` });
    const row = fake.calls.find((c) => c.table === "print_jobs" && c.op === "insert")!.values as Record<string, unknown>;
    expect(row.derived_file_path).toBe(`org/${ORG}/jobs/${JOB}/derived.pdf`);
  });

  it("if a move fails the job is NOT created, the quota is released and the files that did move are removed", async () => {
    const p = await plan();
    fake = fakeSupabase((call: FakeCall): FakeResult => {
      if (call.op === "rpc" && call.table === "adjust_monthly_usage") return ok(true);
      if (call.op === "move" && (call.values as { to: string }).to.endsWith("derived.pdf")) return failure("object not found");
      return ok({ job_number: "JOB-1" });
    });
    const res = await finishPrintJob(fake.client as never, session, null, "r.pdf", baseOpts(), p, prepared(), stored(`prepared/${ORG}/${JOB}/abc.pdf`));
    expect(res).toMatchObject({ ok: false, code: "storage_failed" });
    expect(fake.calls.some((c) => c.table === "print_jobs" && c.op === "insert")).toBe(false);
    const modes = fake.calls.filter((c) => c.op === "rpc" && c.table === "adjust_monthly_usage").map((c) => (c.values as { p_mode: string }).p_mode);
    expect(modes).toEqual(["reserve", "release"]);
    const removed = fake.calls.filter((c) => c.op === "remove").flatMap((c) => c.values as string[]);
    expect(removed).toContain(`org/${ORG}/jobs/${JOB}/original.pdf`);
  });

  it("finishing the same prepare job twice cannot create two jobs (the print job id is the primary key)", async () => {
    const p = await plan();
    const first = await finishPrintJob(fake.client as never, session, null, "r.pdf", baseOpts(), p, prepared(), stored());
    expect(first.ok).toBe(true);
    fake = fakeSupabase((call: FakeCall): FakeResult => {
      if (call.op === "rpc") return ok(true);
      if (call.table === "print_jobs" && call.op === "insert") return failure("duplicate key value violates unique constraint");
      return ok();
    });
    const second = await finishPrintJob(fake.client as never, session, null, "r.pdf", baseOpts(), p, prepared(), stored());
    expect(second).toMatchObject({ ok: false, code: "insert_failed" });
  });
});

describe("the four parts together (limits, plan, PDF work, finish) are exactly createPrintJob", () => {
  /** Everything that can legitimately differ run to run (generated ids and clock times) is blanked; the rest must be identical. */
  const normalize = (calls: FakeCall[]) =>
    JSON.parse(
      JSON.stringify(calls.filter((c) => c.op !== "select"), (_k, v) => (v instanceof Uint8Array ? `bytes:${v.length}` : v))
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
        .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<time>"),
    );

  it.each([
    ["a plain job", baseOpts()],
    ["a page range", baseOpts({ choices: { sides: "two", staple: "none", booklet: "none", copies: 2, pageRange: "1-2" } })],
    ["a held job", baseOpts({ forcedHeldReason: "Held on purpose." })],
  ])("%s: same writes, same result", async (_name, opts) => {
    use();
    const whole = await createPrintJob(fake.client as never, session, pdf3, "r.pdf", opts);
    const wholeWrites = normalize(fake.calls);

    use();
    expect(await checkSubmitLimits(fake.client as never, session)).toBeNull();
    const planned = await resolveJobPlan(fake.client as never, session, pdf3.byteLength, opts);
    if (!planned.ok) throw new Error("plan failed");
    const p = planned.plan;
    const prepared = await preparePdf({
      originalBytes: pdf3,
      maxUploadBytes: p.maxUploadBytes,
      colorMode: p.colorMode,
      heldReason: p.heldReason,
      forcedHeldReason: opts.forcedHeldReason,
      pageRangeText: opts.choices.pageRange.trim() === "" ? null : opts.choices.pageRange.trim(),
      booklet: p.booklet,
      bookletOptions: { paperSize: p.paperSize, bindingSide: p.bindingSide ?? p.profileBindingSide, fit: p.bookletFit, sheet: p.bookletSheet },
      confirmBookletPadding: opts.confirmBookletPadding,
      stamp: null,
      allowType3Fonts: false,
      logContext: {},
      logger: { warn: () => {}, error: () => {} },
    });
    if (!prepared.ok) throw new Error("prepare failed");
    const pieces = await finishPrintJob(fake.client as never, session, pdf3, "r.pdf", opts, p, prepared);

    expect(normalize([...fake.calls])).toEqual(wholeWrites);
    expect(JSON.stringify(pieces).replace(/[0-9a-f-]{36}/g, "<uuid>")).toBe(JSON.stringify(whole).replace(/[0-9a-f-]{36}/g, "<uuid>"));
  });
});
