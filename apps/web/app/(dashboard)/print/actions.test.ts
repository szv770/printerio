import { beforeEach, describe, expect, it, vi } from "vitest";

// The server actions are thin: parse the form, call the shared pipeline, redirect on success. These tests pin
// that wrapper (the pipeline itself is covered in lib/jobs/create-print-job.test.ts).
class RedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string): never => {
    throw new RedirectSignal(to);
  },
}));

const createPrintJob = vi.fn();
vi.mock("@/lib/jobs/create-print-job", () => ({ createPrintJob: (...a: unknown[]) => createPrintJob(...a) }));

const session = { userId: "u1", membership: { organization_id: "org1", role: "staff", department: null } };
vi.mock("@/lib/auth/session", () => ({ requireSessionOrRedirect: async () => session }));
const supabase = { marker: "user-client" };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabase }));
const serviceClient: Record<string, unknown> = { marker: "service-role-client" };
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => serviceClient }));

import { submitPrintJobAction } from "./actions";

function form(over: Record<string, string> = {}, file: File | null = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "doc.pdf")) {
  const fd = new FormData();
  if (file) fd.set("file", file);
  const fields: Record<string, string> = { sides: "two", staple: "none", booklet: "none", copies: "3", pageRange: "1-2", printerProfileId: "p1", ...over };
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => createPrintJob.mockReset());

describe("submitPrintJobAction", () => {
  it("passes the member's own client, session, bytes and the parsed form to the shared pipeline, then redirects to the job", async () => {
    createPrintJob.mockResolvedValue({ ok: true, jobId: "job-9", jobNumber: "JOB-1", status: "approved", heldReason: null, policyReasons: [] });
    await expect(submitPrintJobAction({}, form())).rejects.toMatchObject({ to: "/jobs/job-9" });
    const [client, sess, bytes, name, opts] = createPrintJob.mock.calls[0]!;
    expect(client).toBe(supabase);
    expect(sess).toBe(session);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(name).toBe("doc.pdf");
    expect(opts).toEqual({
      printerProfileId: "p1",
      choices: { sides: "two", staple: "none", booklet: "none", copies: 3, pageRange: "1-2" },
      colorMode: "bw",
      paperSize: "letter",
      punch: false,
      confirmBookletPadding: false,
      bookletFit: "fill",
      bookletSheet: "letter",
      writeClient: serviceClient,
    });
  });

  it("does every write with the service-role client (writeClient), never the member's", async () => {
    createPrintJob.mockResolvedValue({ ok: true, jobId: "job-9", jobNumber: "JOB-1", status: "approved", heldReason: null, policyReasons: [] });
    await expect(submitPrintJobAction({}, form())).rejects.toBeInstanceOf(RedirectSignal);
    expect(createPrintJob.mock.calls[0]![4].writeClient).toBe(serviceClient);
    expect(createPrintJob.mock.calls[0]![4].writeClient).not.toBe(supabase);
  });

  it("ignores status / approval / ownership fields smuggled into the form", async () => {
    createPrintJob.mockResolvedValue({ ok: true, jobId: "job-9", jobNumber: "JOB-1", status: "approved", heldReason: null, policyReasons: [] });
    const fd = form({ status: "approved", approved_by: "u1", approved_at: "2026-01-01", created_by: "other", organization_id: "other-org", policy_action: "allow", estimated_physical_sheets: "0" });
    await expect(submitPrintJobAction({}, fd)).rejects.toBeInstanceOf(RedirectSignal);
    const [, sess, , , opts] = createPrintJob.mock.calls[0]!;
    expect(sess).toBe(session); // identity and organization come from the session only
    expect(Object.keys(opts).sort()).toEqual(["bookletFit", "bookletSheet", "choices", "colorMode", "confirmBookletPadding", "paperSize", "printerProfileId", "punch", "writeClient"]);
  });

  it("returns an error as form state, with its field error", async () => {
    createPrintJob.mockResolvedValue({ ok: false, kind: "error", code: "invalid_page_range", error: "The document only has 3 pages.", fieldErrors: { pageRange: "The document only has 3 pages." } });
    expect(await submitPrintJobAction({}, form())).toEqual({ error: "The document only has 3 pages.", fieldErrors: { pageRange: "The document only has 3 pages." } });
  });

  it("returns a plain error without fieldErrors when there are none", async () => {
    createPrintJob.mockResolvedValue({ ok: false, kind: "error", code: "quota_exceeded", error: "quota" });
    expect(await submitPrintJobAction({}, form())).toEqual({ error: "quota" });
  });

  it("returns the booklet confirmation exactly as before (no error key)", async () => {
    const needs = { sourcePages: 3, paddedPages: 4, blankPagesAdded: 1 };
    createPrintJob.mockResolvedValue({ ok: false, kind: "needs_booklet_confirm", needsBookletConfirm: needs });
    expect(await submitPrintJobAction({}, form())).toEqual({ needsBookletConfirm: needs });
  });

  it("refuses a missing file and junk choices before the pipeline runs", async () => {
    expect(await submitPrintJobAction({}, form({}, null))).toEqual({ error: "Choose a PDF to upload." });
    expect(await submitPrintJobAction({}, form({ sides: "" }))).toMatchObject({ error: expect.stringMatching(/single-sided or double-sided/) });
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it("answers the blank-pages question the same however long the member waited (the server keeps no state between the two submits)", async () => {
    vi.useFakeTimers();
    try {
      const needs = { sourcePages: 10, paddedPages: 12, blankPagesAdded: 2 };
      createPrintJob.mockResolvedValueOnce({ ok: false, kind: "needs_booklet_confirm", needsBookletConfirm: needs });
      expect(await submitPrintJobAction({}, form({ booklet: "left" }))).toEqual({ needsBookletConfirm: needs });

      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000); // two hours later

      createPrintJob.mockResolvedValueOnce({ ok: true, jobId: "job-7", jobNumber: "JOB-7", status: "approved", heldReason: null, policyReasons: [] });
      await expect(submitPrintJobAction({ needsBookletConfirm: needs }, form({ booklet: "left", confirmBookletPadding: "true" }))).rejects.toMatchObject({ to: "/jobs/job-7" });
      expect(createPrintJob.mock.calls[1]![4]).toMatchObject({ confirmBookletPadding: true, writeClient: serviceClient });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("submitPrintJobAction with a staged (direct-uploaded) file", () => {
  const UID = "u1";
  const path = `gateway-intake/${UID}/0b3c1f7e-1111-4222-8333-444455556666.pdf`;
  function stageStorage(blob: Blob | null, limit = 1000) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const bucket = {
      list: async () => ({ data: [{ name, metadata: { size: blob?.size ?? 0 } }], error: null }),
      download: async () => (blob ? { data: blob, error: null } : { data: null, error: { message: "x" } }),
      remove: async () => ({ error: null }),
    };
    serviceClient.storage = { from: () => bucket };
    serviceClient.from = () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { max_upload_size_bytes: limit } }) }) }) });
  }

  it("downloads the staged object with the service role and runs the pipeline on its bytes and the posted file name", async () => {
    stageStorage(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46, 1])]));
    createPrintJob.mockResolvedValue({ ok: true, jobId: "job-9", jobNumber: "JOB-1", status: "approved", heldReason: null, policyReasons: [] });
    await expect(submitPrintJobAction({}, form({ stagedPath: path, fileName: "big.pdf" }, null))).rejects.toMatchObject({ to: "/jobs/job-9" });
    const [, , bytes, name] = createPrintJob.mock.calls[0]!;
    expect(Array.from(bytes as Uint8Array)).toEqual([0x25, 0x50, 0x44, 0x46, 1]);
    expect(name).toBe("big.pdf");
  });

  it("refuses a staged object over the organization's size limit, before any job exists", async () => {
    stageStorage(new Blob([new Uint8Array(50)]), 10);
    const res = await submitPrintJobAction({}, form({ stagedPath: path, fileName: "big.pdf" }, null));
    expect(res.error).toMatch(/larger than/i);
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it("refuses somebody else's staged path", async () => {
    stageStorage(new Blob([new Uint8Array(5)]));
    const res = await submitPrintJobAction({}, form({ stagedPath: "gateway-intake/other-user/0b3c1f7e-1111-4222-8333-444455556666.pdf", fileName: "x.pdf" }, null));
    expect(res.error).toMatch(/didn't finish uploading/i);
    expect(createPrintJob).not.toHaveBeenCalled();
  });
});

