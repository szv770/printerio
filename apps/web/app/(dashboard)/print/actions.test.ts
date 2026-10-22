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
    });
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
});
