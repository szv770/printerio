import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, failure, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";
import type { PrepareJobParams, PrepareWire } from "@printio/pdf/prepare-wire";

vi.setConfig({ testTimeout: 30_000 });
const evaluateJobPolicy = vi.fn();
vi.mock("@/lib/policy/build-facts", () => ({ evaluateJobPolicy: (...a: unknown[]) => evaluateJobPolicy(...a) }));
const ensureMemberUserCode = vi.fn(async () => "SV42");
vi.mock("@/lib/jobs/ensure-user-code", () => ({ ensureMemberUserCode: (...a: unknown[]) => ensureMemberUserCode(...(a as [])) }));

import type { JobOptions, JobSession } from "@/lib/jobs/create-print-job";
import { intakePrintJob } from "./intake";
import { finishPrepareJob, type PrepareJobRow } from "./finish";
import { cancelPrepareJob } from "./cancel";
import { confirmBookletForPrepareJob } from "./confirm";
import { retryStuckFinishes, STUCK_AFTER_MS } from "./retry";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const USER = "00000000-0000-4000-8000-000000000001";
const OTHER_USER = "00000000-0000-4000-8000-000000000002";
const session: JobSession = { userId: USER, membership: { organization_id: ORG, role: "staff", department: null } };
const STAGED = `gateway-intake/${USER}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf`;

const profileRow = (over: Record<string, unknown> = {}) => ({
  id: "profile-1", output_mode: "raw", booklet_binding_side: "left", raw_staple_position: "top-left",
  declared_capabilities: { duplex: true, staple: true, booklet: true }, declared_paper_sizes: ["letter"], pricing: null,
  printers: { id: "printer-1", organization_id: ORG }, ...over,
});
const baseOpts = (over: Partial<JobOptions> = {}): JobOptions => ({
  printerProfileId: "profile-1",
  choices: { sides: "one", staple: "none", booklet: "none", copies: 1, pageRange: "" },
  colorMode: "bw", paperSize: "letter", punch: false, confirmBookletPadding: false, ...over,
});

type Row = Record<string, unknown>;
interface World {
  serverJobs: Row[];
  printJobs: Row[];
  objects: Map<string, number>; // storage path -> size
  settings: Row;
  profile: unknown;
  member: Row | null;
  rateOk: boolean;
  quotaOk: boolean;
  openJobs: number;
}
let w: World;
let fake: ReturnType<typeof fakeSupabase>;

function world(over: Partial<World> = {}): World {
  return {
    serverJobs: [], printJobs: [], objects: new Map([[STAGED, 1234]]),
    settings: { max_upload_size_bytes: 52428800, quota_basis: "physical_sheets", job_approval_expiry_hours: 72, stamp_enabled: false },
    profile: profileRow(), member: { user_code: null, profiles: { display_name: "Ms A", email: "a@x.org" }, role: "staff", department: null, status: "active" },
    rateOk: true, quotaOk: true, openJobs: 0, ...over,
  };
}

function match(row: Row, call: FakeCall): boolean {
  return call.filters.every(([name, ...a]) => {
    if (name === "eq") return row[a[0] as string] === a[1];
    if (name === "in") return (a[1] as unknown[]).includes(row[a[0] as string]);
    if (name === "lt") return row[a[0] as string] != null && String(row[a[0] as string]) < String(a[1]);
    return true;
  });
}

function respond(call: FakeCall): FakeResult {
  if (call.op === "rpc" && call.table === "check_rate_limit") return ok(w.rateOk);
  if (call.op === "rpc" && call.table === "adjust_monthly_usage") return ok(w.quotaOk);
  if (call.table === "printer_profiles") return ok(w.profile);
  if (call.table === "organization_settings") return ok(w.settings);
  if (call.table === "organization_members") return ok(w.member);
  if (call.table === "storage:print-jobs") {
    if (call.op === "list") {
      const { folder, options } = call.values as { folder: string; options?: { search?: string } };
      const files = [...w.objects].filter(([p]) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes("/")).map(([p, size]) => ({ name: p.slice(folder.length + 1), metadata: { size } }));
      return ok(options?.search ? files.filter((f) => f.name === options.search) : files);
    }
    if (call.op === "remove") for (const p of call.values as string[]) w.objects.delete(p);
    if (call.op === "move") {
      const { from, to } = call.values as { from: string; to: string };
      if (!w.objects.has(from)) return failure("object not found");
      w.objects.set(to, w.objects.get(from)!);
      w.objects.delete(from);
    }
    if (call.op === "upload") w.objects.set((call.values as { path: string }).path, 1);
    return ok();
  }
  if (call.table === "print_jobs") {
    if (call.op === "select" && call.single === "maybeSingle") return ok(w.printJobs.find((r) => match(r, call)) ?? null);
    if (call.op === "select") return { data: null, error: null, count: w.openJobs };
    if (call.op === "insert") {
      const row = call.values as Row;
      if (w.printJobs.some((r) => r.id === row.id)) return failure("duplicate key value violates unique constraint");
      w.printJobs.push(row);
      return ok({ job_number: "JOB-2026-000042" });
    }
    return ok();
  }
  if (call.table === "server_jobs") {
    if (call.op === "insert") { w.serverJobs.push({ status: "queued", claimed_by: null, result: null, error: null, ...(call.values as Row) }); return ok(); }
    const hit = w.serverJobs.filter((r) => match(r, call));
    if (call.op === "select") return ok(call.single ? (hit[0] ?? null) : hit);
    if (call.op === "update") {
      const target = call.single ? hit.slice(0, 1) : hit;
      for (const r of target) Object.assign(r, call.values as Row);
      return ok(call.single ? (target[0] ? { ...target[0] } : null) : target);
    }
  }
  return ok();
}

const jobRow = (): Row => w.serverJobs[0]!;
const asPrepareRow = (r: Row): PrepareJobRow => ({ id: r.id as string, organization_id: r.organization_id as string, requested_by: r.requested_by as string, source_path: r.source_path as string, params: r.params });
const preparedWire = (id: string, over: Partial<PrepareWire> = {}): PrepareWire => ({
  preparedPath: null, sourcePages: 3, bookletPaddingAdded: 0, held: false, heldReason: null, effectivePageCount: 3, pageRangeText: null, fileSizeBytes: 1234, pictureCopy: false, ...over,
});

beforeEach(() => {
  w = world();
  fake = fakeSupabase((c) => respond(c));
  ensureMemberUserCode.mockClear();
  evaluateJobPolicy.mockReset();
  evaluateJobPolicy.mockResolvedValue({ result: { action: "allow", reasons: [] }, quotaLimit: 100, adminsBypassRestrictions: false, quotaBasis: "physical_sheets", groupIds: [] });
});

const intake = (opts: JobOptions = baseOpts(), path = STAGED) => intakePrintJob(fake.client as never, session, path, "report.pdf", opts);
const finish = (wire: PrepareWire, row: Row = jobRow()) => finishPrepareJob(fake.client as never, asPrepareRow(row), wire);
const paramsOf = (): PrepareJobParams => jobRow().params as PrepareJobParams;

describe("intakePrintJob (the website records the job without opening the PDF)", () => {
  it("records a queued prepare job for the sender's school, pointing at the upload, and returns at once", async () => {
    const r = await intake();
    expect(r.ok).toBe(true);
    expect(w.serverJobs).toHaveLength(1);
    expect(jobRow()).toMatchObject({ kind: "prepare_pdf", organization_id: ORG, requested_by: USER, source_path: STAGED, status: "queued" });
    expect(jobRow().id).toBe(r.ok && r.prepareJobId);
    expect(jobRow().dedupe_key).toBe(`prepare:${jobRow().id}`);
    // The file itself was never read: only a listing, no download and no upload.
    expect(fake.calls.some((c) => c.table === "storage:print-jobs" && (c.op === "download" || c.op === "upload"))).toBe(false);
  });

  it("carries everything the print server and the finish step need, and nothing about the database", async () => {
    await intake(baseOpts({ choices: { sides: "two", staple: "none", booklet: "right", copies: 2, pageRange: " 1-2 " } }));
    const p = paramsOf();
    expect(p.v).toBe(1);
    expect(p.pdf).toMatchObject({ maxUploadBytes: 52428800, colorMode: "bw", heldReason: null, pageRangeText: "1-2", booklet: true, confirmBookletPadding: false, stamp: null, allowType3Fonts: false });
    expect(p.pdf.bookletOptions).toMatchObject({ paperSize: "letter", bindingSide: "right", fit: "fill", sheet: "letter" });
    expect(p.finish).toMatchObject({ originalFileName: "report.pdf", options: { printerProfileId: "profile-1", paperSize: "letter" } });
    expect(JSON.stringify(p)).not.toMatch(/service|secret|token/i);
  });

  it("carries an optional page layout into the print server's params, and leaves the key out without one", async () => {
    await intake(baseOpts({ layout: { kind: "nup", cols: 2, rows: 1 } }));
    expect(paramsOf().pdf.layout).toEqual({ kind: "nup", cols: 2, rows: 1 });
    w = world();
    await intake();
    expect(paramsOf().pdf).not.toHaveProperty("layout");
  });

  it("the person's limits are checked first and counted once, before anything is looked up", async () => {
    w.rateOk = false;
    expect(await intake()).toMatchObject({ ok: false, code: "rate_limited" });
    expect(fake.calls.some((c) => c.op === "list" || c.table === "printer_profiles")).toBe(false);
    expect(w.serverJobs).toHaveLength(0);
    w = world();
    fake = fakeSupabase((c) => respond(c));
    await intake();
    expect(fake.calls.filter((c) => c.op === "rpc" && c.table === "check_rate_limit")).toHaveLength(1);
  });

  it("refuses a file that is not this person's upload, or that never finished uploading, and records nothing", async () => {
    const stranger = `gateway-intake/${OTHER_USER}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf`;
    w.objects.set(stranger, 1000);
    for (const path of [stranger, `gateway-intake/${USER}/../${OTHER_USER}/x.pdf`, `gateway-intake/${USER}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.pdf`]) {
      const r = await intake(baseOpts(), path);
      expect(r).toMatchObject({ ok: false, code: "storage_failed" });
    }
    expect(w.serverJobs).toHaveLength(0);
  });

  it("a file over the school's limit is refused (and its upload removed), never queued", async () => {
    w.objects.set(STAGED, 60 * 1024 * 1024);
    expect(await intake()).toMatchObject({ ok: false, code: "too_large" });
    expect(w.objects.has(STAGED)).toBe(false);
    expect(w.serverJobs).toHaveLength(0);
  });

  it("an unavailable printer is refused inline; a choice the printer cannot honour becomes a hold the print server will carry out", async () => {
    w.profile = null;
    expect(await intake()).toMatchObject({ ok: false, code: "printer_unavailable" });
    w = world({ profile: profileRow({ declared_capabilities: { duplex: true, staple: false, booklet: true } }) });
    fake = fakeSupabase((c) => respond(c));
    await intake(baseOpts({ choices: { sides: "one", staple: "top-left", booklet: "none", copies: 1, pageRange: "" } }));
    expect(paramsOf().pdf.heldReason).toBeTruthy();
  });

  it("the code stamp is built here for a normal job (the print server has no database) and never for a held one", async () => {
    w.settings = { ...w.settings, stamp_enabled: true, stamp_strength: "medium" };
    await intake();
    expect(ensureMemberUserCode).toHaveBeenCalledTimes(1);
    expect(paramsOf().pdf.stamp).toMatchObject({ text: expect.stringContaining("SV42"), strength: expect.any(String) });

    w = world({ profile: profileRow({ declared_capabilities: { duplex: true, staple: false, booklet: true } }) });
    w.settings = { max_upload_size_bytes: 52428800, quota_basis: "physical_sheets", job_approval_expiry_hours: 72, stamp_enabled: true };
    fake = fakeSupabase((c) => respond(c));
    ensureMemberUserCode.mockClear();
    await intake(baseOpts({ choices: { sides: "one", staple: "top-left", booklet: "none", copies: 1, pageRange: "" } }));
    expect(ensureMemberUserCode).not.toHaveBeenCalled();
    expect(paramsOf().pdf.stamp).toBeNull();
  });

  it("if the stamp cannot be prepared the job still goes through without it", async () => {
    w.settings = { ...w.settings, stamp_enabled: true };
    ensureMemberUserCode.mockRejectedValueOnce(new Error("could not save the code"));
    expect((await intake()).ok).toBe(true);
    expect(paramsOf().pdf.stamp).toBeNull();
  });

  it("choices that would not fit in the job record are refused with a plain message, never stored half-way", async () => {
    const r = await intake(baseOpts({ choices: { sides: "one", staple: "none", booklet: "none", copies: 1, pageRange: "1,".repeat(9000) } }));
    expect(r).toMatchObject({ ok: false, code: "invalid_request" });
    expect(w.serverJobs).toHaveLength(0);
  });
});

describe("finishPrepareJob (the print server reported: create the print job on the real numbers)", () => {
  async function queued(opts: JobOptions = baseOpts()) {
    const r = await intake(opts);
    if (!r.ok) throw new Error("intake failed");
    return r.prepareJobId;
  }
  const JOBPATH = (id: string) => `org/${ORG}/jobs/${id}`;

  it("creates the print job with the prepare job's id, moves the files into their usual place, and records the result", async () => {
    const id = await queued();
    const prepared = `prepared/${ORG}/${id}/p.pdf`;
    w.objects.set(prepared, 999);
    const out = await finish(preparedWire(id, { preparedPath: prepared }));
    expect(out).toEqual({ status: "finished", printJobId: id });
    expect(w.printJobs).toHaveLength(1);
    expect(w.printJobs[0]).toMatchObject({ id, organization_id: ORG, created_by: USER, status: "approved", source_pdf_pages: 3, original_file_name: "report.pdf", original_file_path: `${JOBPATH(id)}/original.pdf`, derived_file_path: `${JOBPATH(id)}/derived.pdf` });
    expect(w.objects.has(`${JOBPATH(id)}/original.pdf`)).toBe(true);
    expect(w.objects.has(`${JOBPATH(id)}/derived.pdf`)).toBe(true);
    expect(w.objects.has(STAGED)).toBe(false);
    expect(w.objects.has(prepared)).toBe(false);
    expect(jobRow().result).toMatchObject({ printJobId: id, jobNumber: "JOB-2026-000042", status: "approved" });
  });

  it("the rules and quota are decided now, on the real page count (quota reserved once)", async () => {
    const id = await queued();
    await finish(preparedWire(id, { sourcePages: 7, effectivePageCount: 7 }));
    expect(evaluateJobPolicy).toHaveBeenCalledOnce();
    expect(evaluateJobPolicy.mock.calls[0]![1]).toMatchObject({ pageCount: 7, organizationId: ORG, userId: USER });
    expect(fake.calls.filter((c) => c.op === "rpc" && c.table === "adjust_monthly_usage")).toHaveLength(1);
  });

  it("running it again for the same job changes nothing (no second print job, no second quota reservation)", async () => {
    const id = await queued();
    await finish(preparedWire(id));
    const reservations = fake.calls.filter((c) => c.op === "rpc" && c.table === "adjust_monthly_usage").length;
    expect(await finish(preparedWire(id))).toEqual({ status: "already_finished", printJobId: id });
    expect(w.printJobs).toHaveLength(1);
    expect(fake.calls.filter((c) => c.op === "rpc" && c.table === "adjust_monthly_usage")).toHaveLength(reservations);
  });

  it("a held result is stored held: no rules, no quota", async () => {
    const id = await queued();
    const out = await finish(preparedWire(id, { held: true, heldReason: "Choose a binding side." }));
    expect(out.status).toBe("finished");
    expect(w.printJobs[0]).toMatchObject({ status: "held", held_reason: "Choose a binding side." });
    expect(evaluateJobPolicy).not.toHaveBeenCalled();
  });

  it("a file the print server cannot print fails the job with its plain reason and removes the upload; no print job", async () => {
    const id = await queued();
    const out = await finish({ preparedPath: null, sourcePages: 0, rejectedReason: "This PDF is password protected." });
    expect(out).toEqual({ status: "failed", error: "This PDF is password protected." });
    expect(jobRow()).toMatchObject({ status: "failed", error: "This PDF is password protected." });
    expect(w.objects.has(STAGED)).toBe(false);
    expect(w.printJobs).toHaveLength(0);
    expect(id).toBeTruthy();
  });

  it("an inline error keeps the field it belongs to in the stored result", async () => {
    await queued();
    const out = await finish({ preparedPath: null, sourcePages: 0, error: { code: "invalid_page_range", message: "The document only has 3 pages.", fieldErrors: { pageRange: "The document only has 3 pages." } } });
    expect(out.status).toBe("failed");
    expect((jobRow().result as PrepareWire).error?.fieldErrors?.pageRange).toBe("The document only has 3 pages.");
    expect(w.printJobs).toHaveLength(0);
  });

  it("a booklet that needs blank pages confirmed is a question, not a failure: the upload is kept and no print job exists yet", async () => {
    await queued();
    const out = await finish({ preparedPath: null, sourcePages: 5, needsBookletConfirm: { sourcePages: 5, paddedPages: 8, blankPagesAdded: 3 } });
    expect(out).toEqual({ status: "needs_booklet_confirm" });
    expect(jobRow().status).not.toBe("failed");
    expect((jobRow().result as PrepareWire).needsBookletConfirm).toEqual({ sourcePages: 5, paddedPages: 8, blankPagesAdded: 3 });
    expect(w.objects.has(STAGED)).toBe(true);
    expect(w.printJobs).toHaveLength(0);
  });

  it("an answer without the finish fields (an older print server) fails clearly instead of guessing", async () => {
    await queued();
    expect((await finish({ preparedPath: null, sourcePages: 3 })).status).toBe("failed");
    expect(w.printJobs).toHaveLength(0);
  });

  it("someone who is no longer an active member cannot get a job created", async () => {
    const id = await queued();
    w.member = { ...(w.member as Row), status: "suspended" };
    const out = await finish(preparedWire(id));
    expect(out).toMatchObject({ status: "failed", error: expect.stringMatching(/no longer print/i) });
    expect(w.printJobs).toHaveLength(0);
    expect(w.objects.has(STAGED)).toBe(false);
  });

  it("over the monthly quota on the real count: failed with the plain message, files removed, nothing created", async () => {
    const id = await queued();
    w.quotaOk = false;
    const out = await finish(preparedWire(id));
    expect(out).toMatchObject({ status: "failed", error: expect.stringMatching(/quota/i) });
    expect(w.printJobs).toHaveLength(0);
    expect(w.objects.has(STAGED)).toBe(false);
    expect(jobRow().status).toBe("failed");
  });

  it("a job that needs more sheets than one job may use is refused after preparing", async () => {
    const id = await queued();
    const out = await finish(preparedWire(id, { sourcePages: 500, effectivePageCount: 500 }));
    expect(out).toMatchObject({ status: "failed", error: expect.stringMatching(/sheets/i) });
    expect(w.printJobs).toHaveLength(0);
  });

  it("a job the sender cancelled is never finished, even if this runs late; its files are cleaned up and no print job appears", async () => {
    const id = await queued();
    jobRow().status = "cancelled";
    w.objects.set(`prepared/${ORG}/${id}/p.pdf`, 9);
    const out = await finish(preparedWire(id, { preparedPath: `prepared/${ORG}/${id}/p.pdf` }));
    expect(out).toEqual({ status: "failed", error: "The sender cancelled this file." });
    expect(w.printJobs).toHaveLength(0);
    expect(w.objects.has(STAGED)).toBe(false);
    expect(w.objects.has(`prepared/${ORG}/${id}/p.pdf`)).toBe(false);
    expect(jobRow().status).toBe("cancelled");
    expect(evaluateJobPolicy).not.toHaveBeenCalled();
  });

  it("a prepare job with unreadable params fails with a plain message", async () => {
    await queued();
    jobRow().params = { nonsense: true };
    expect((await finish(preparedWire("x"))).status).toBe("failed");
  });
});

describe("cancelPrepareJob (safe, because preparing is fast)", () => {
  async function queued() {
    const r = await intake();
    if (!r.ok) throw new Error("intake failed");
    return r.prepareJobId;
  }
  const cancel = (id: string, userId = USER) => cancelPrepareJob(fake.client as never, userId, id);

  it("cancels a waiting job, removes the upload and anything the print server already uploaded", async () => {
    const id = await queued();
    w.objects.set(`prepared/${ORG}/${id}/p.pdf`, 5);
    expect(await cancel(id)).toEqual({ ok: true });
    expect(jobRow()).toMatchObject({ status: "cancelled", lease_until: null });
    expect(w.objects.has(STAGED)).toBe(false);
    expect([...w.objects.keys()].some((p) => p.startsWith("prepared/"))).toBe(false);
  });

  it("cancels a job a print server is working on too (it will be told 409 cancelled)", async () => {
    const id = await queued();
    jobRow().status = "claimed";
    expect(await cancel(id)).toEqual({ ok: true });
    expect(jobRow().status).toBe("cancelled");
  });

  it("only the sender can cancel it; anyone else gets 'not found' and nothing changes", async () => {
    const id = await queued();
    expect(await cancel(id, OTHER_USER)).toEqual({ ok: false, reason: "not_found" });
    expect(jobRow().status).toBe("queued");
    expect(w.objects.has(STAGED)).toBe(true);
  });

  it("after the print job exists it is too late: the answer carries the print job's id and nothing is removed", async () => {
    const id = await queued();
    jobRow().status = "claimed"; // the complete route marks the job done before finishing; finishing itself leaves it done
    await finish(preparedWire(id));
    expect(jobRow().status).toBe("done");
    const before = w.objects.size;
    expect(await cancel(id)).toEqual({ ok: false, reason: "too_late", printJobId: id });
    expect(w.objects.size).toBe(before);
    expect(w.printJobs).toHaveLength(1);
  });

  it("a second cancel is harmless", async () => {
    const id = await queued();
    await cancel(id);
    expect(await cancel(id)).toMatchObject({ ok: false, reason: "too_late" });
  });

  it("does not touch a job of another school even with the right id and user", async () => {
    const id = await queued();
    jobRow().organization_id = OTHER_ORG;
    jobRow().requested_by = OTHER_USER;
    expect(await cancel(id)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("retryStuckFinishes (the website died after marking the job done and before creating the print job)", () => {
  const OLD = () => new Date(Date.now() - 5 * 60_000).toISOString();
  async function stuck(over: Record<string, unknown> = {}) {
    const r = await intake();
    if (!r.ok) throw new Error("intake failed");
    Object.assign(jobRow(), { status: "done", finished_at: OLD(), result: preparedWire(r.prepareJobId), ...over });
    return r.prepareJobId;
  }
  const retry = (opts: { organizationId?: string } = {}) => retryStuckFinishes(fake.client as never, opts);

  it("finishes a job that was left half-done: the print job appears and the result records it", async () => {
    const id = await stuck();
    expect(await retry()).toBe(1);
    expect(w.printJobs).toHaveLength(1);
    expect(w.printJobs[0]).toMatchObject({ id, status: "approved" });
    expect((jobRow().result as { printJobId?: string }).printJobId).toBe(id);
  });

  it("leaves a job alone that only just finished (a finish may still be running right now)", async () => {
    await stuck({ finished_at: new Date(Date.now() - STUCK_AFTER_MS / 4).toISOString() });
    expect(await retry()).toBe(0);
    expect(w.printJobs).toHaveLength(0);
  });

  it("skips everything that is not stuck: already finished, an error, a booklet question, a rejection; and cancelled or failed jobs", async () => {
    const id = await stuck();
    jobRow().result = { ...preparedWire(id), printJobId: id };
    expect(await retry()).toBe(0);
    for (const result of [
      { preparedPath: null, sourcePages: 0, error: { code: "bad_pdf", message: "Not a PDF." } },
      { preparedPath: null, sourcePages: 5, needsBookletConfirm: { sourcePages: 5, paddedPages: 8, blankPagesAdded: 3 } },
      { preparedPath: null, sourcePages: 0, rejectedReason: "Password protected." },
    ]) {
      jobRow().result = result;
      expect(await retry()).toBe(0);
    }
    jobRow().result = preparedWire(id);
    for (const status of ["cancelled", "failed", "queued", "claimed"]) {
      jobRow().status = status;
      expect(await retry()).toBe(0);
    }
    expect(w.printJobs).toHaveLength(0);
  });

  it("running it twice does not create a second job", async () => {
    await stuck();
    expect(await retry()).toBe(1);
    expect(await retry()).toBe(0);
    expect(w.printJobs).toHaveLength(1);
  });

  it("scoped to one school it never touches another school's job", async () => {
    await stuck();
    expect(await retry({ organizationId: OTHER_ORG })).toBe(0);
    expect(w.printJobs).toHaveLength(0);
    expect(await retry({ organizationId: ORG })).toBe(1);
  });

  it("RACE: a second finish that loses must NOT mark the job failed or touch the winner's files", async () => {
    const id = await stuck();
    // The winner has already created the print job and moved the files, but has not recorded its result yet.
    w.printJobs.push({ id, status: "approved" });
    w.objects.delete(STAGED);
    w.objects.set(`org/${ORG}/jobs/${id}/original.pdf`, 1234);
    // The loser's early "does the print job exist?" look happens a moment BEFORE the winner's insert, so it sees nothing...
    let firstLook = true;
    fake = fakeSupabase((c) => {
      if (c.table === "print_jobs" && c.op === "select" && c.single === "maybeSingle" && firstLook) {
        firstLook = false;
        return ok(null);
      }
      return respond(c);
    });
    const out = await finish(preparedWire(id));
    // ... so its insert collides on the primary key, and the failure path checks again and finds the winner.
    expect(out).toEqual({ status: "already_finished", printJobId: id });
    expect(jobRow().status).toBe("done");
    expect(w.objects.has(`org/${ORG}/jobs/${id}/original.pdf`)).toBe(true);
  });
});

describe("the print server's idle poll finishes its own school's stuck jobs", () => {
  it("claim on an idle queue retries stuck finishes for that school only (covered end to end by retryStuckFinishes; wired in the claim route)", async () => {
    const r = await intake();
    if (!r.ok) throw new Error("intake failed");
    Object.assign(jobRow(), { status: "done", finished_at: new Date(Date.now() - 5 * 60_000).toISOString(), result: preparedWire(r.prepareJobId) });
    expect(await retryStuckFinishes(fake.client as never, { organizationId: ORG, limit: 2 })).toBe(1);
  });
});

describe("confirmBookletForPrepareJob (the 'yes, add the blank pages' button)", () => {
  const NEEDS = { preparedPath: null, sourcePages: 5, needsBookletConfirm: { sourcePages: 5, paddedPages: 8, blankPagesAdded: 3 } };
  const confirm = (user = session.userId) => confirmBookletForPrepareJob(fake.client as never, user, jobRow().id as string);

  it("puts the same job back in the queue with the confirmation set, clearing the question", async () => {
    const r = await intake();
    if (!r.ok) throw new Error("intake failed");
    Object.assign(jobRow(), { status: "done", result: NEEDS, claimed_by: "agent-1", finished_at: new Date().toISOString() });
    expect(await confirm()).toBe(true);
    expect(jobRow()).toMatchObject({ id: r.prepareJobId, status: "queued", result: null, claimed_by: null, finished_at: null });
    expect((jobRow().params as { pdf: { confirmBookletPadding: boolean } }).pdf.confirmBookletPadding).toBe(true);
  });
  it("does nothing for a job that is not waiting on that question, or that is someone else's", async () => {
    await intake();
    expect(await confirm()).toBe(false); // queued, no question
    Object.assign(jobRow(), { status: "done", result: NEEDS });
    expect(await confirm("someone-else")).toBe(false);
    expect(jobRow().status).toBe("done");
    jobRow().status = "cancelled";
    expect(await confirm()).toBe(false);
  });
});
