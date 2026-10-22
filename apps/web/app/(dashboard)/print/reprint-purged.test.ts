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

import { reprintJobAction } from "./actions";

const fd = () => {
  const f = new FormData();
  f.set("jobId", "j1");
  return f;
};

beforeEach(() => {
  download.mockReset().mockResolvedValue({ data: null, error: { message: "Object not found" } });
  createPrintJob.mockReset();
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
});
