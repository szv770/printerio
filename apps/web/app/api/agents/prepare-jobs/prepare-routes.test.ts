import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";

type Row = Record<string, unknown>;
type Agent = { id: string; organizationId: string; paused: boolean };

const ORG1 = "11111111-1111-4111-8111-111111111111";
const ORG2 = "22222222-2222-4222-8222-222222222222";
const A1 = { id: "aaaaaaaa-0000-4000-8000-000000000001", organizationId: ORG1, paused: false };
const A1_OTHER = { id: "aaaaaaaa-0000-4000-8000-000000000002", organizationId: ORG1, paused: false }; // second server, same school
const A2 = { id: "aaaaaaaa-0000-4000-8000-000000000003", organizationId: ORG2, paused: false };
const USER = "cccccccc-0000-4000-8000-000000000001";

let agent: Agent | null = A1;
vi.mock("@/lib/agent-auth", () => ({ authenticateAgentRequest: async () => agent }));

let jobs: Row[] = [];
let fake: ReturnType<typeof fakeSupabase>;
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => fake.client }));

/** A tiny in-memory server_jobs table that applies the same filters PostgREST would, so scoping bugs show up as wrong output. */
function matches(row: Row, call: FakeCall): boolean {
  return call.filters.every(([name, ...a]) => {
    if (name === "eq") return row[a[0] as string] === a[1];
    if (name === "lt") return row[a[0] as string] != null && (row[a[0] as string] as string) < (a[1] as string);
    if (name === "or") {
      const expr = a[0] as string;
      const lease = /lease_until\.lt\.([^,)]+)/.exec(expr)?.[1];
      return row.status === "queued" || (row.status === "claimed" && lease !== undefined && row.lease_until != null && (row.lease_until as string) < lease);
    }
    return true; // order, limit, returning
  });
}
function simulate(call: FakeCall): FakeResult {
  if (call.table === "storage:print-jobs") {
    if (call.op === "sign_download") return ok({ signedUrl: `https://signed.test/get/${(call.values as { path: string }).path}` });
    if (call.op === "sign_upload") return ok({ token: "upload-token-1", signedUrl: "x" });
    return ok();
  }
  if (call.table !== "server_jobs") return ok();
  const hit = jobs.filter((r) => matches(r, call)).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const limit = call.filters.find((f) => f[0] === "limit")?.[1] as number | undefined;
  const rows = limit ? hit.slice(0, limit) : hit;
  if (call.op === "select") return ok(call.single ? (rows[0] ?? null) : rows);
  if (call.op === "update") {
    const target = call.single ? rows.slice(0, 1) : hit;
    for (const r of target) Object.assign(r, call.values as Row);
    return ok(call.single ? (target[0] ? { id: target[0].id } : null) : target);
  }
  return ok();
}

import { POST as claimPOST } from "./claim/route";
import { POST as originalPOST } from "./[jobId]/original/route";
import { POST as slotPOST } from "./[jobId]/upload-slot/route";
import { POST as renewPOST } from "./[jobId]/renew/route";
import { POST as completePOST } from "./[jobId]/complete/route";
import { POST as failPOST } from "./[jobId]/fail/route";

/** A moment that has certainly passed (an expired lease). */
const PAST = () => new Date(Date.now() - 60_000).toISOString();
const T = (sec: number) => new Date(Date.UTC(2026, 10, 19, 12, 0, sec)).toISOString();
const job = (n: number, over: Row = {}): Row => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  kind: "prepare_pdf",
  organization_id: ORG1,
  requested_by: USER,
  params: { choices: { sides: "one" } },
  source_path: `intake/${ORG1}/${USER}/${n}.pdf`,
  status: "queued",
  claimed_by: null,
  lease_until: null,
  error: null,
  result: null,
  created_at: T(n),
  ...over,
});
const id = (n: number) => job(n).id as string;
const post = (url: string, body?: unknown) =>
  new Request(`http://x${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (n: number) => ({ params: Promise.resolve({ jobId: id(n) }) });
const claimed = (n: number, by: Agent = A1, over: Row = {}) => job(n, { status: "claimed", claimed_by: by.id, lease_until: new Date(Date.now() + 60_000).toISOString(), ...over });
const rowOf = (n: number) => jobs.find((r) => r.id === id(n))!;

beforeEach(() => {
  agent = A1;
  jobs = [];
  fake = fakeSupabase(simulate);
});

describe("claim (one school's print server only ever gets its own school's jobs)", () => {
  it("answers 204 when nothing is waiting", async () => {
    expect((await claimPOST(post("/c"))).status).toBe(204);
  });

  it("hands out the oldest waiting job of its own school and leases it", async () => {
    jobs = [job(2), job(1)];
    const res = await claimPOST(post("/c"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ jobId: id(1), leaseSeconds: 120 });
    expect(rowOf(1)).toMatchObject({ status: "claimed", claimed_by: A1.id });
    expect(new Date(rowOf(1).lease_until as string).getTime()).toBeGreaterThan(Date.now());
    expect(rowOf(2).status).toBe("queued");
  });

  it("another school's print server never sees or takes this school's job", async () => {
    jobs = [job(1)];
    agent = A2;
    expect((await claimPOST(post("/c"))).status).toBe(204);
    expect(rowOf(1)).toMatchObject({ status: "queued", claimed_by: null });
  });

  it("never hands out library jobs", async () => {
    jobs = [job(1, { kind: "library_fetch", requested_by: null, source_path: null })];
    expect((await claimPOST(post("/c"))).status).toBe(204);
    expect(rowOf(1).status).toBe("queued");
  });

  it("a paused print server takes nothing", async () => {
    jobs = [job(1)];
    agent = { ...A1, paused: true };
    expect((await claimPOST(post("/c"))).status).toBe(204);
    expect(rowOf(1).status).toBe("queued");
  });

  it("a job whose lease ran out goes to another server of the same school, a held one does not", async () => {
    jobs = [claimed(1, A1, { lease_until: PAST() }), claimed(2, A1)];
    agent = A1_OTHER;
    const res = await claimPOST(post("/c"));
    expect((await res.json()).jobId).toBe(id(1));
    expect(rowOf(1).claimed_by).toBe(A1_OTHER.id);
    expect(rowOf(2).claimed_by).toBe(A1.id);
    expect((await claimPOST(post("/c"))).status).toBe(204);
  });

  it("gives up on jobs that waited more than 24 hours, for its own school only", async () => {
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    jobs = [job(1, { created_at: old }), job(2, { created_at: old, organization_id: ORG2 })];
    expect((await claimPOST(post("/c"))).status).toBe(204);
    expect(rowOf(1)).toMatchObject({ status: "failed", error: "expired" });
    expect(rowOf(2).status).toBe("queued");
  });

  it("refuses an unauthenticated caller", async () => {
    agent = null;
    expect((await claimPOST(post("/c"))).status).toBe(401);
  });
});

describe("original / upload-slot (lease required, server chooses every path)", () => {
  it("returns a signed link for the job's own original, whatever the caller sends", async () => {
    jobs = [claimed(1)];
    const res = await originalPOST(post("/o", { path: "someone/elses/file.pdf" }), ctx(1));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe(`https://signed.test/get/intake/${ORG1}/${USER}/1.pdf`);
    expect(fake.calls.filter((c) => c.op === "sign_download").map((c) => (c.values as { path: string }).path)).toEqual([`intake/${ORG1}/${USER}/1.pdf`]);
  });

  it("another school's server gets 404 (it looks like a missing job), another server of the same school 403", async () => {
    jobs = [claimed(1)];
    agent = A2;
    expect((await originalPOST(post("/o"), ctx(1))).status).toBe(404);
    expect((await slotPOST(post("/s"), ctx(1))).status).toBe(404);
    agent = A1_OTHER;
    expect((await originalPOST(post("/o"), ctx(1))).status).toBe(403);
    expect((await slotPOST(post("/s"), ctx(1))).status).toBe(403);
    expect(fake.calls.some((c) => c.op === "sign_download" || c.op === "sign_upload")).toBe(false);
  });

  it("a queued job (no lease yet), an expired lease, and a bad id are refused", async () => {
    jobs = [job(1), claimed(2, A1, { lease_until: PAST() })];
    expect((await originalPOST(post("/o"), ctx(1))).status).toBe(403);
    expect((await originalPOST(post("/o"), ctx(2))).status).toBe(403);
    expect((await originalPOST(post("/o"), { params: Promise.resolve({ jobId: "not-a-uuid" }) })).status).toBe(404);
  });

  it("a cancelled job says so (409 cancelled) so the print server drops its work", async () => {
    jobs = [claimed(1, A1, { status: "cancelled" })];
    const res = await originalPOST(post("/o"), ctx(1));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("cancelled");
  });

  it("the upload slot is inside this job's own folder and the path is chosen by the server", async () => {
    jobs = [claimed(1)];
    const res = await slotPOST(post("/s", { path: "evil/../x.pdf" }), ctx(1));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe("upload-token-1");
    expect(body.path).toMatch(new RegExp(`^prepared/${ORG1}/${id(1)}/[0-9a-f-]{36}\\.pdf$`));
  });
});

describe("renew", () => {
  it("extends a held lease", async () => {
    jobs = [claimed(1, A1, { lease_until: new Date(Date.now() + 5_000).toISOString() })];
    const before = rowOf(1).lease_until as string;
    const res = await renewPOST(post("/r"), ctx(1));
    expect(res.status).toBe(200);
    expect(new Date(rowOf(1).lease_until as string).getTime()).toBeGreaterThan(new Date(before).getTime() + 60_000);
  });
  it("cannot renew someone else's, an expired, or another school's job", async () => {
    jobs = [claimed(1), claimed(2, A1, { lease_until: PAST() })];
    agent = A1_OTHER;
    expect((await renewPOST(post("/r"), ctx(1))).status).toBe(403);
    agent = A1;
    expect((await renewPOST(post("/r"), ctx(2))).status).toBe(403);
    agent = A2;
    expect((await renewPOST(post("/r"), ctx(1))).status).toBe(404);
  });
});

describe("complete", () => {
  const good = (n: number, over: Row = {}) => ({
    result: { preparedPath: `prepared/${ORG1}/${id(n)}/${"a".repeat(8)}-0000-4000-8000-${"b".repeat(12)}.pdf`, sourcePages: 12, bookletPaddingAdded: 0, flags: ["type3_fonts_rasterized"], fidelity: "same", ...over },
  });

  it("stores the result and marks the job done", async () => {
    jobs = [claimed(1)];
    const res = await completePOST(post("/c", good(1)), ctx(1));
    expect(res.status).toBe(200);
    expect(rowOf(1)).toMatchObject({ status: "done", lease_until: null });
    expect((rowOf(1).result as Row).sourcePages).toBe(12);
    expect(rowOf(1).finished_at).toBeTruthy();
  });

  it("accepts 'print the original as it is' (no prepared file) and a plain rejection reason", async () => {
    jobs = [claimed(1), claimed(2)];
    expect((await completePOST(post("/c", { result: { preparedPath: null, sourcePages: 3 } }), ctx(1))).status).toBe(200);
    expect((await completePOST(post("/c", { result: { preparedPath: null, sourcePages: 0, rejectedReason: "This PDF is password protected." } }), ctx(2))).status).toBe(200);
    expect((rowOf(2).result as Row).rejectedReason).toBe("This PDF is password protected.");
  });

  it("refuses a prepared file outside this job's own folder (another job, another school, a path trick)", async () => {
    jobs = [claimed(1)];
    for (const preparedPath of [`prepared/${ORG2}/${id(1)}/x.pdf`, `prepared/${ORG1}/${id(9)}/x.pdf`, `intake/${ORG1}/${USER}/1.pdf`, "../prepared"]) {
      const res = await completePOST(post("/c", good(1, { preparedPath })), ctx(1));
      expect(res.status, preparedPath).toBe(400);
    }
    expect(rowOf(1).status).toBe("claimed");
  });

  it("refuses an unexpected shape (unknown keys, bad numbers, no result)", async () => {
    jobs = [claimed(1)];
    for (const body of [{}, { result: { preparedPath: null } }, good(1, { sourcePages: -1 }), good(1, { surprise: true }), good(1, { fidelity: "maybe" })]) {
      expect((await completePOST(post("/c", body), ctx(1))).status).toBe(400);
    }
    expect((await completePOST(new Request("http://x", { method: "POST", body: "{nope" }), ctx(1))).status).toBe(400);
    expect(rowOf(1).status).toBe("claimed");
  });

  it("a job the sender cancelled is NOT completed (409 cancelled), and a second complete is refused", async () => {
    jobs = [claimed(1, A1, { status: "cancelled" }), claimed(2)];
    const res = await completePOST(post("/c", good(1)), ctx(1));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("cancelled");
    expect(rowOf(1).status).toBe("cancelled");
    expect((await completePOST(post("/c", good(2)), ctx(2))).status).toBe(200);
    expect((await completePOST(post("/c", good(2)), ctx(2))).status).toBe(409);
  });

  it("another school's server cannot complete it (404), and another server of the same school gets 403", async () => {
    jobs = [claimed(1)];
    agent = A2;
    expect((await completePOST(post("/c", good(1)), ctx(1))).status).toBe(404);
    agent = A1_OTHER;
    expect((await completePOST(post("/c", good(1)), ctx(1))).status).toBe(403);
    expect(rowOf(1).status).toBe("claimed");
  });
});

describe("fail", () => {
  it("records a plain reason for the sender", async () => {
    jobs = [claimed(1)];
    const res = await failPOST(post("/f", { reason: "This PDF has more pages than the limit." }), ctx(1));
    expect(res.status).toBe(200);
    expect(rowOf(1)).toMatchObject({ status: "failed", error: "This PDF has more pages than the limit." });
  });
  it("needs a short reason, a lease and the right school", async () => {
    jobs = [claimed(1)];
    expect((await failPOST(post("/f", {}), ctx(1))).status).toBe(400);
    expect((await failPOST(post("/f", { reason: "x".repeat(400) }), ctx(1))).status).toBe(400);
    agent = A2;
    expect((await failPOST(post("/f", { reason: "no" }), ctx(1))).status).toBe(404);
    agent = A1_OTHER;
    expect((await failPOST(post("/f", { reason: "no" }), ctx(1))).status).toBe(403);
    expect(rowOf(1).status).toBe("claimed");
  });
});
