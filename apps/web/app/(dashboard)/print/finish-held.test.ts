import { beforeEach, describe, expect, it, vi } from "vitest";

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

let job: Record<string, unknown> | null;
let cancelResult: Array<{ id: string }>;
const updates: Array<{ patch: unknown; filters: Record<string, unknown> }> = [];
const events: unknown[] = [];
const supabase = {
  from(table: string) {
    if (table === "print_job_events") return { insert: async (row: unknown) => (events.push(row), { error: null }) };
    const filters: Record<string, unknown> = {};
    let patch: unknown = null;
    const q: Record<string, unknown> = {
      select: () => q,
      update: (p: unknown) => ((patch = p), q),
      eq: (k: string, v: unknown) => ((filters[k] = v), q),
      maybeSingle: async () => ({ data: job, error: null }),
      then: (resolve: (v: unknown) => void) => {
        updates.push({ patch, filters });
        resolve({ data: cancelResult, error: null });
      },
    };
    return q;
  },
  storage: { from: () => ({ download: async () => ({ data: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]), error: null }) }) },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabase }));

import { finishHeldBookletAction } from "./actions";

const heldBooklet = () => ({
  id: "job-1",
  status: "held",
  held_reason: "Booklet: choose left or right binding.",
  source: "ipp",
  device_id: "dev1",
  finishing: { staple: false, booklet: true, punch: false },
  booklet_binding_side: "left",
  duplex: true,
  copies: 2,
  page_range: "1-8",
  printer_profile_id: "p1",
  color_mode: "bw",
  paper_size: "letter",
  original_file_path: "org1/job-1/orig.pdf",
  original_file_name: "Doc.pdf",
});
const form = (over: Record<string, string> = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ jobId: "job-1", bindingSide: "right", ...over })) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  createPrintJob.mockReset();
  updates.length = 0;
  events.length = 0;
  job = heldBooklet();
  cancelResult = [{ id: "job-1" }];
});

describe("finishHeldBookletAction (member picks left or right on a held booklet)", () => {
  it("re-runs the pipeline on the original with the chosen side, cancels the held job, and goes to the new job", async () => {
    createPrintJob.mockResolvedValue({ ok: true, jobId: "job-2", jobNumber: "J2", status: "approved", heldReason: null, policyReasons: [] });
    await expect(finishHeldBookletAction({}, form())).rejects.toMatchObject({ to: "/jobs/job-2" });
    const [, , bytes, name, opts] = createPrintJob.mock.calls[0]!;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(name).toBe("Doc.pdf");
    expect(opts).toMatchObject({
      printerProfileId: "p1",
      choices: { sides: "two", staple: "none", booklet: "right", copies: 2, pageRange: "1-8" },
      confirmBookletPadding: true,
      source: "ipp",
      deviceId: "dev1",
    });
    expect(opts.forcedHeldReason).toBeUndefined();
    // the held original is closed so the member does not see two jobs; guarded on it still being held
    expect(updates[0]).toEqual({ patch: { status: "cancelled" }, filters: { id: "job-1", status: "held", created_by: "u1" } });
    expect(events[0]).toMatchObject({ job_id: "job-1", event_type: "JOB_CANCELLED" });
  });

  it("works for left too", async () => {
    createPrintJob.mockResolvedValue({ ok: true, jobId: "job-2", jobNumber: "J2", status: "approved", heldReason: null, policyReasons: [] });
    await expect(finishHeldBookletAction({}, form({ bindingSide: "left" }))).rejects.toBeInstanceOf(RedirectSignal);
    expect(createPrintJob.mock.calls[0]![4].choices.booklet).toBe("left");
  });

  it("refuses anything but left or right, before doing any work", async () => {
    for (const bindingSide of ["", "profile", "top"]) {
      expect(await finishHeldBookletAction({}, form({ bindingSide }))).toEqual({ error: "Choose left or right binding." });
    }
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it("refuses a job that is not a held booklet (or not the caller's)", async () => {
    job = { ...heldBooklet(), status: "approved" };
    expect(await finishHeldBookletAction({}, form())).toMatchObject({ error: expect.stringMatching(/no longer waiting/i) });
    job = { ...heldBooklet(), finishing: { staple: true, booklet: false, punch: false } };
    expect(await finishHeldBookletAction({}, form())).toMatchObject({ error: expect.stringMatching(/no longer waiting/i) });
    job = { ...heldBooklet(), held_reason: "Booklet: choose left or right binding. Paper size iso_a4 is not available yet." };
    expect(await finishHeldBookletAction({}, form())).toMatchObject({ error: expect.stringMatching(/no longer waiting/i) });
    job = null;
    expect(await finishHeldBookletAction({}, form())).toEqual({ error: "Job not found." });
    expect(createPrintJob).not.toHaveBeenCalled();
  });

  it("keeps the held job when the new job cannot be made, and shows the reason", async () => {
    createPrintJob.mockResolvedValue({ ok: false, kind: "error", code: "quota_exceeded", error: "quota" });
    expect(await finishHeldBookletAction({}, form())).toEqual({ error: "quota" });
    expect(updates).toHaveLength(0);
  });
});
