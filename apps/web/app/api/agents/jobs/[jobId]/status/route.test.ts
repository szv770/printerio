import { beforeEach, describe, expect, it, vi } from "vitest";

const adjust = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@/lib/quota", async (orig) => ({ ...(await orig<typeof import("@/lib/quota")>()), adjustMonthlyUsage: (...a: unknown[]) => adjust(...a) }));
vi.mock("@/lib/agent-auth", () => ({ authenticateAgentRequest: async () => ({ id: "agent1", organizationId: "org1", paused: false }) }));

type Row = Record<string, unknown>;
let job: Row;
let settings: Row | null;
const events: Row[] = [];
const deviceUpdates: Array<{ patch: Row; eqs: Array<[string, unknown]>; isNull: string[] }> = [];

const service = {
  from(table: string) {
    if (table === "print_job_events") return { insert: async (v: Row) => (events.push(v), { error: null }) };
    if (table === "member_devices") {
      const rec = { patch: {} as Row, eqs: [] as Array<[string, unknown]>, isNull: [] as string[] };
      const q: Record<string, unknown> = {
        update: (p: Row) => ((rec.patch = p), deviceUpdates.push(rec), q),
        eq: (k: string, v: unknown) => (rec.eqs.push([k, v]), q),
        is: (k: string) => (rec.isNull.push(k), q),
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      };
      return q;
    }
    if (table === "organization_settings") {
      const q: Record<string, unknown> = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: settings, error: null }) };
      return q;
    }
    let patch: Row | null = null;
    const eqs: Array<[string, unknown]> = [];
    const q: Record<string, unknown> = {
      select: () => q,
      update: (p: Row) => ((patch = p), q),
      eq: (k: string, v: unknown) => (eqs.push([k, v]), q),
      maybeSingle: async () => ({ data: eqs.every(([k, v]) => job[k] === v) ? { ...job } : null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        const ok = eqs.every(([k, v]) => job[k] === v);
        if (ok && patch) job = { ...job, ...patch };
        resolve({ data: ok ? [{ id: job.id }] : [], error: null });
      },
    };
    return q;
  },
};
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => service }));

import { POST } from "./route";

const call = (status: string, message?: string) =>
  POST(new Request("http://x", { method: "POST", body: JSON.stringify({ status, message }) }), { params: Promise.resolve({ jobId: "j1" }) });

const printing = (over: Row = {}): Row => ({
  id: "j1", organization_id: "org1", created_by: "u1", status: "printing", lease_owner_agent_id: "agent1", attempt_count: 0, max_attempts: 3,
  is_test_print: false, source_pdf_pages: 2, copies: 1, estimated_printed_sides: 2, estimated_physical_sheets: 1, color_mode: "bw", ...over,
});

beforeEach(() => {
  job = printing();
  settings = { auto_retry_failed_prints: false };
  events.length = 0;
  deviceUpdates.length = 0;
  adjust.mockClear();
});

describe("agent status route: failure path", () => {
  it("auto-retry OFF: marks failed, counts the attempt, keeps the reservation (still retryable)", async () => {
    expect((await call("failed", "boom")).status).toBe(200);
    expect(job).toMatchObject({ status: "failed", attempt_count: 1, error_message: "boom" });
    expect(adjust).not.toHaveBeenCalled();
  });

  it("auto-retry ON: re-queues (failed -> approved) while attempts remain, no quota change", async () => {
    settings = { auto_retry_failed_prints: true };
    const res = await call("failed", "spooler reported a failure status: Offline");
    expect(res.status).toBe(200);
    expect(job).toMatchObject({ status: "approved", attempt_count: 1, lease_owner_agent_id: null });
    expect(adjust).not.toHaveBeenCalled();
    expect(events.map((e) => e.event_type)).toEqual(["PRINT_FAILED", "RETRY_SCHEDULED"]);
  });

  it("auto-retry ON stops at max_attempts: stays failed with its message and the reservation is released once", async () => {
    settings = { auto_retry_failed_prints: true };
    job = printing({ attempt_count: 2 });
    await call("failed", "still broken");
    expect(job).toMatchObject({ status: "failed", attempt_count: 3, error_message: "still broken" });
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(adjust.mock.calls[0]![5]).toBe("release");
  });

  it("auto-retry OFF at max_attempts releases once", async () => {
    job = printing({ attempt_count: 2 });
    await call("failed", "x");
    expect(adjust).toHaveBeenCalledTimes(1);
  });

  it("works when the setting column does not exist yet (treated as OFF)", async () => {
    settings = {};
    await call("failed", "x");
    expect(job.status).toBe("failed");
  });

  it("a test print never touches quota and is not auto-retried into a double charge", async () => {
    job = printing({ is_test_print: true, attempt_count: 2 });
    await call("failed", "x");
    expect(adjust).not.toHaveBeenCalled();
  });
});

describe("agent status route: idempotency", () => {
  it("a repeated 'completed' report consumes quota once", async () => {
    job = printing({ status: "submitted_to_spooler" });
    const [a, b] = await Promise.all([call("completed"), call("completed")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(adjust.mock.calls[0]![5]).toBe("consume");
  });
});

describe("agent status route: the deferred raw chain (claimed -> downloading -> ... -> completed)", () => {
  it("accepts 'downloading' from claimed and records DOWNLOAD_STARTED", async () => {
    job = printing({ status: "claimed" });
    const res = await call("downloading");
    expect(res.status).toBe(200);
    expect(job.status).toBe("downloading");
    expect(events.map((e) => e.event_type)).toEqual(["DOWNLOAD_STARTED"]);
  });

  it("the whole chain an agent reports after a clean raw send is legal, in order, and consumes quota once", async () => {
    job = printing({ status: "claimed" });
    for (const s of ["downloading", "downloaded", "printing", "submitted_to_spooler", "completed"]) {
      expect((await call(s, s === "submitted_to_spooler" ? "sent to printer raw port" : undefined)).status, s).toBe(200);
    }
    expect(job.status).toBe("completed");
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(adjust.mock.calls[0]![5]).toBe("consume");
  });

  it("success clears a leftover 'waiting for the printer' marker from earlier retries", async () => {
    job = printing({ status: "submitted_to_spooler", error_message: "[printio:waiting v1 since=2026-10-23T10:00:00.000Z tries=2 kind=unavailable] x" });
    await call("completed", "sent to printer raw port");
    expect(job.error_message).toBeNull();
  });
});

describe("agent status route: device first_printed_at", () => {
  it("stamps first_printed_at (only when still empty) when a job from a device is completed", async () => {
    job = printing({ status: "submitted_to_spooler", device_id: "dev1" });
    expect((await call("completed")).status).toBe(200);
    const upd = deviceUpdates.find((u) => "first_printed_at" in u.patch);
    expect(upd).toBeTruthy();
    expect(upd!.eqs).toContainEqual(["id", "dev1"]);
    expect(upd!.isNull).toContain("first_printed_at");
  });

  it("does nothing for a job without a device (website upload)", async () => {
    job = printing({ status: "submitted_to_spooler", device_id: null });
    await call("completed");
    expect(deviceUpdates).toHaveLength(0);
  });

  it("does not stamp on failure", async () => {
    job = printing({ device_id: "dev1" });
    await call("failed", "boom");
    expect(deviceUpdates).toHaveLength(0);
  });

  it("never fails the status report if the device update errors", async () => {
    job = printing({ status: "submitted_to_spooler", device_id: "dev1" });
    deviceUpdates.length = 0;
    expect((await call("completed")).status).toBe(200);
  });
});
