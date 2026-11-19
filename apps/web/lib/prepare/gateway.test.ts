import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fakeSupabase, ok } from "@/test/fake-supabase";
import { gatewayStatusOfPrepare, loadGatewayPrepareJob } from "./gateway";

const params = (deviceId: string, source = "ipp") => ({ finish: { originalFileName: "p.pdf", options: { deviceId, source } } });
const row = (over: Record<string, unknown> = {}) => ({ id: "j1", status: "queued", params: params("dev1"), result: null, ...over });

describe("loadGatewayPrepareJob", () => {
  it("returns the job only for the device that made it through the print dialog", async () => {
    const f = fakeSupabase(() => ok(row()));
    expect(await loadGatewayPrepareJob(f.client as never, "j1", "dev1")).toMatchObject({ id: "j1" });
    expect(await loadGatewayPrepareJob(f.client as never, "j1", "dev2")).toBeNull();
    const web = fakeSupabase(() => ok(row({ params: params("dev1", "web") })));
    expect(await loadGatewayPrepareJob(web.client as never, "j1", "dev1")).toBeNull();
    expect(await loadGatewayPrepareJob(fakeSupabase(() => ok(null)).client as never, "j1", "dev1")).toBeNull();
  });
});

describe("gatewayStatusOfPrepare", () => {
  it("maps what the phone should be told", () => {
    expect(gatewayStatusOfPrepare(row())).toEqual({ status: "draft" });
    expect(gatewayStatusOfPrepare(row({ status: "claimed" }))).toEqual({ status: "draft" });
    expect(gatewayStatusOfPrepare(row({ status: "done", result: { printJobId: "j1" } }))).toBeNull();
    expect(gatewayStatusOfPrepare(row({ status: "cancelled" }))).toEqual({ status: "cancelled" });
    expect(gatewayStatusOfPrepare(row({ status: "done", result: { error: { code: "bad_pdf", message: "Not a PDF." } } }))).toEqual({ status: "denied", message: "Not a PDF." });
    expect(gatewayStatusOfPrepare(row({ status: "failed", result: { error: "expired" } }))?.status).toBe("denied");
  });
});
