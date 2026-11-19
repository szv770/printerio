import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, failure, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";

let responder: (call: FakeCall) => FakeResult = () => ok();
let fake: ReturnType<typeof fakeSupabase>;
let factoryThrows = false;
vi.mock("@/lib/supabase/service-role", () => ({
  createServiceRoleClient: () => {
    if (factoryThrows) throw new Error("Missing environment variables");
    return fake.client;
  },
}));

import { GET } from "./route";

const get = (query = "") => GET(new Request(`https://printio.test/api/health${query}`));

beforeEach(() => {
  factoryThrows = false;
  responder = () => ok([{ id: "o1" }]);
  fake = fakeSupabase((call) => responder(call));
});

describe("GET /api/health", () => {
  it("answers 200 with build info and never touches the database by default (a deploy waits on this)", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", service: "printio-web" });
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("commit");
    expect(body).not.toHaveProperty("database");
    expect(fake.calls).toHaveLength(0);
  });

  it("deep check: 200 when the database answers", async () => {
    const res = await get("?deep=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", database: "ok" });
    expect(fake.calls.some((c) => c.table === "organizations")).toBe(true);
  });

  it("deep check: 503 degraded when the database errors", async () => {
    responder = () => failure("connection refused");
    const res = await get("?deep=1");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "degraded", database: "down" });
  });

  it("deep check: 503 degraded (not a crash) when the database settings are missing", async () => {
    factoryThrows = true;
    const res = await get("?deep=1");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "degraded", database: "down" });
  });

  it("the plain check still says ok when the database is down (a good release must not look broken)", async () => {
    responder = () => failure("connection refused");
    const res = await get();
    expect(res.status).toBe(200);
  });

  it("returns no secrets or tenant data: only the documented keys", async () => {
    const body = await (await get("?deep=1")).json();
    expect(Object.keys(body).sort()).toEqual(["builtAt", "commit", "database", "service", "status", "version"]);
  });
});
