import { describe, expect, it, vi } from "vitest";
import { fakeSupabase, failure, ok, type FakeCall } from "@/test/fake-supabase";

vi.mock("@/lib/policy/build-facts", () => ({ evaluateJobPolicy: vi.fn() }));
import { checkSubmitLimits, DEFAULT_ORG_DAILY_JOB_LIMIT, orgDailyJobLimit, type JobSession } from "./create-print-job";

const session: JobSession = { userId: "user-1", membership: { organization_id: "org-1", role: "staff", department: null } };

function client(orgAnswer: (call: FakeCall) => ReturnType<typeof ok>) {
  return fakeSupabase((call) => {
    if (call.table === "check_rate_limit") {
      return (call.values as { p_key: string }).p_key.startsWith("org_daily_jobs:") ? orgAnswer(call) : ok(true);
    }
    return { data: null, error: null, count: 0 };
  });
}
const orgCalls = (fake: ReturnType<typeof client>) => fake.calls.filter((c) => c.table === "check_rate_limit" && (c.values as { p_key: string }).p_key.startsWith("org_daily_jobs:"));

describe("organization daily upload cap", () => {
  it("allows a job while the school is under its daily limit", async () => {
    const fake = client(() => ok(true));
    expect(await checkSubmitLimits(fake.client as never, session)).toBeNull();
    expect(orgCalls(fake)[0]!.values).toEqual({ p_key: "org_daily_jobs:org-1", p_max_count: DEFAULT_ORG_DAILY_JOB_LIMIT, p_window_seconds: 86400 });
  });

  it("refuses with a plain-English message once the school is over its daily limit", async () => {
    const fake = client(() => ok(false));
    const res = await checkSubmitLimits(fake.client as never, session);
    expect(res).toMatchObject({ ok: false, code: "rate_limited", error: expect.stringMatching(/daily print-upload limit.*tomorrow.*admin/) });
    // Nothing else was touched: no quota, no job rows.
    expect(fake.calls.filter((c) => c.op === "insert" || c.op === "update")).toHaveLength(0);
  });

  it("fails open when the daily check returns an error", async () => {
    const fake = client(() => failure("permission denied"));
    expect(await checkSubmitLimits(fake.client as never, session)).toBeNull();
  });

  it("fails open when the daily check throws", async () => {
    const base = client(() => ok(true));
    const throwing = {
      ...base.client,
      rpc: (name: string, args: { p_key: string }) => {
        if (args.p_key.startsWith("org_daily_jobs:")) throw new Error("network down");
        return base.client.rpc(name, args);
      },
    };
    expect(await checkSubmitLimits(throwing as never, session)).toBeNull();
  });

  it("limit comes from the env var; 0 switches it off; junk falls back to the default", async () => {
    expect(orgDailyJobLimit({})).toBe(DEFAULT_ORG_DAILY_JOB_LIMIT);
    expect(orgDailyJobLimit({ PRINTIO_ORG_DAILY_JOB_LIMIT: "250" })).toBe(250);
    expect(orgDailyJobLimit({ PRINTIO_ORG_DAILY_JOB_LIMIT: "0" })).toBe(0);
    expect(orgDailyJobLimit({ PRINTIO_ORG_DAILY_JOB_LIMIT: "lots" })).toBe(DEFAULT_ORG_DAILY_JOB_LIMIT);
  });
});
