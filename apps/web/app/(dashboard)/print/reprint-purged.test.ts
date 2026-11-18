import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ redirect: (to: string): never => { throw new Error(`redirect:${to}`); } }));
const createPrintJob = vi.fn();
vi.mock("@/lib/jobs/create-print-job", () => ({ createPrintJob: (...a: unknown[]) => createPrintJob(...a) }));
const session = { userId: "u1", membership: { organization_id: "org1", role: "staff", department: null } };
vi.mock("@/lib/auth/session", () => ({ requireSessionOrRedirect: async () => session }));

const download = vi.fn();
let jobRow: Record<string, unknown> | null = null;
const supabase = {
  from: () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) chain[m] = () => chain;
    chain.maybeSingle = async () => ({ data: jobRow, error: null });
    return chain;
  },
  storage: { from: () => ({ download }) },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabase }));

const serviceDownload = vi.fn();
const serviceCalls: string[] = [];
const serviceClient = {
  storage: { from: () => ({ download: (p: string) => (serviceCalls.push(`download:${p}`), serviceDownload(p)) }) },
  from: (t: string) => (serviceCalls.push(`from:${t}`), {}),
};
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => serviceClient }));

import { reprintJobAction } from "./actions";

const fd = () => {
  const f = new FormData();
  f.set("jobId", "j1");
  return f;
};

beforeEach(() => {
  download.mockReset().mockResolvedValue({ data: null, error: { message: "Object not found" } });
  createPrintJob.mockReset();
  serviceDownload.mockReset().mockResolvedValue({ data: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]), error: null });
  serviceCalls.length = 0;
});

describe("reprintJobAction on a purged job", () => {
  it("gives the friendly 'file removed' message without trying to download", async () => {
    jobRow = { id: "j1", files_purged_at: "2026-10-20T00:00:00Z", original_file_path: "org/org1/jobs/j1/original.pdf" };
    const res = await reprintJobAction({}, fd());
    expect(res.error).toMatch(/removed/i);
    expect(res.error).toMatch(/original document/i);
    expect(download).not.toHaveBeenCalled();
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it("also covers a row with no stored path", async () => {
    jobRow = { id: "j1", files_purged_at: null, original_file_path: null };
    const res = await reprintJobAction({}, fd());
    expect(res.error).toMatch(/original document/i);
  });

  it("refuses another user's job: the owner-scoped read finds nothing, so the service role is never touched", async () => {
    jobRow = null;
    const res = await reprintJobAction({}, fd());
    expect(res).toEqual({ error: "Job not found." });
    expect(serviceCalls).toEqual([]);
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it("downloads the original with the service-role client (never the member's) once ownership is proven, and writes via it", async () => {
    jobRow = {
      id: "j1",
      files_purged_at: null,
      original_file_path: "org/org1/jobs/j1/original.pdf",
      original_file_name: "a.pdf",
      finishing: { staple: false, booklet: false, punch: false },
      duplex: false,
      copies: 1,
      page_range: null,
      color_mode: "bw",
      paper_size: "letter",
      printer_profile_id: "p1",
    };
    createPrintJob.mockResolvedValue({ ok: false, kind: "error", code: "quota_exceeded", error: "quota" });
    await reprintJobAction({}, fd());
    expect(download).not.toHaveBeenCalled();
    expect(serviceCalls).toEqual(["download:org/org1/jobs/j1/original.pdf"]);
    expect(createPrintJob.mock.calls[0]![4].writeClient).toBe(serviceClient);
  });

  it("carries every finishing key into the new job: short-edge flip, staple corner, booklet side / fit / sheet, 11x17", async () => {
    const base = {
      id: "j1",
      files_purged_at: null,
      original_file_path: "org/org1/jobs/j1/original.pdf",
      original_file_name: "a.pdf",
      copies: 3,
      page_range: "2-5",
      color_mode: "bw",
      printer_profile_id: "p1",
    };
    createPrintJob.mockResolvedValue({ ok: false, kind: "error", code: "quota_exceeded", error: "quota" });

    // short-edge flip, stapled top-right, 11x17
    jobRow = { ...base, duplex: true, paper_size: "tabloid", finishing: { staple: true, booklet: false, punch: false, duplexEdge: "short" }, staple_position: "top-right", booklet_binding_side: null };
    await reprintJobAction({}, fd());
    const flat = createPrintJob.mock.calls[0]![4];
    expect(flat.choices).toEqual({ sides: "two", staple: "top-right", booklet: "none", copies: 3, flip: "short", pageRange: "2-5" });
    expect(flat.paperSize).toBe("11x17");

    // booklet bound right, keep margins
    createPrintJob.mockClear();
    jobRow = { ...base, duplex: true, paper_size: "letter", finishing: { staple: false, booklet: true, punch: false, bookletFit: "keep" }, staple_position: null, booklet_binding_side: "right" };
    await reprintJobAction({}, fd());
    const bk = createPrintJob.mock.calls[0]![4];
    expect(bk.choices.booklet).toBe("right");
    expect(bk.bookletFit).toBe("keep");
    expect(bk.bookletSheet).toBe("letter");

    // tabloid booklet sheet, two staples on the left
    createPrintJob.mockClear();
    jobRow = { ...base, duplex: false, paper_size: "tabloid", finishing: { staple: true, booklet: true, punch: false, stapleStyle: "dual-left", bookletFit: "fill", bookletSheet: "tabloid" }, staple_position: "top-left", booklet_binding_side: "left" };
    await reprintJobAction({}, fd());
    const tab = createPrintJob.mock.calls[0]![4];
    expect(tab.bookletSheet).toBe("tabloid");
    expect(tab.choices.staple).toBe("dual-left");
  });
});
