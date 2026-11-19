import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { fakeSupabase, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";

vi.mock("@/lib/policy/build-facts", () => ({
  evaluateJobPolicy: async () => ({ result: { action: "allow", reasons: [] }, quotaLimit: 100, adminsBypassRestrictions: false, quotaBasis: "physical_sheets", groupIds: [] }),
}));
vi.mock("@printio/pdf/content-analysis", () => ({ analyzePdfContent: async () => null }));
// The REAL preparePdf runs; the spy only records what it was given.
const preparePdfSpy = vi.fn();
vi.mock("@printio/pdf/prepare", async (importOriginal) => {
  const real = await importOriginal<typeof import("@printio/pdf/prepare")>();
  return { ...real, preparePdf: (...a: Parameters<typeof real.preparePdf>) => (preparePdfSpy(...a), real.preparePdf(...a)) };
});

import { createPrintJob, type JobOptions, type JobSession } from "./create-print-job";

const session: JobSession = { userId: "user-1", membership: { organization_id: "org-1", role: "staff", department: null } };
const profile = {
  id: "profile-1", output_mode: "raw", booklet_binding_side: "left", raw_staple_position: "top-left",
  declared_capabilities: { duplex: true, staple: true, booklet: true }, declared_paper_sizes: ["letter"], pricing: null,
  printers: { id: "printer-1", organization_id: "org-1" },
};
const opts = (over: Partial<JobOptions> = {}): JobOptions => ({
  printerProfileId: "profile-1",
  choices: { sides: "one", staple: "none", booklet: "none", copies: 1, pageRange: "" },
  colorMode: "bw", paperSize: "letter", punch: false, confirmBookletPadding: false, ...over,
});

let fake: ReturnType<typeof fakeSupabase>;
let pdf4: Uint8Array;
beforeAll(async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i++) doc.addPage([612, 792]);
  pdf4 = await doc.save();
});
beforeEach(() => {
  preparePdfSpy.mockClear();
  fake = fakeSupabase((call: FakeCall): FakeResult => {
    if (call.op === "rpc" && call.table === "check_rate_limit") return ok(true);
    if (call.op === "rpc" && call.table === "adjust_monthly_usage") return ok(true);
    if (call.table === "printer_profiles") return ok(profile);
    if (call.table === "organization_settings") return ok({ max_upload_size_bytes: 52428800, quota_basis: "physical_sheets", job_approval_expiry_hours: 72, stamp_enabled: false });
    if (call.table === "storage:print-jobs" && call.op === "upload") return ok({ path: "x" });
    if (call.table === "print_jobs" && call.op === "insert") return ok({ job_number: "JOB-2026-000007" });
    return ok();
  });
});
const go = (o: JobOptions) => createPrintJob(fake.client as never, session, pdf4, "report.pdf", o);

describe("createPrintJob: optional layout from a print preset", () => {
  it("passes the layout to preparePdf and the job counts the sheets the layout makes (4 pages, 2 per sheet = 2)", async () => {
    const layout = { kind: "nup", cols: 2, rows: 1 } as const;
    const res = await go(opts({ layout }));
    expect(res.ok).toBe(true);
    expect(preparePdfSpy.mock.calls[0]![0]).toMatchObject({ layout });
    const row = fake.calls.find((c) => c.table === "print_jobs" && c.op === "insert")!.values as Record<string, unknown>;
    expect(row).toMatchObject({ source_pdf_pages: 4, estimated_printed_sides: 2, estimated_physical_sheets: 2 });
  });

  it("without a layout preparePdf gets no layout key at all", async () => {
    await go(opts());
    expect(preparePdfSpy.mock.calls[0]![0]).not.toHaveProperty("layout");
  });
});
