import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const intake = vi.fn();
vi.mock("./intake", () => ({ intakePrintJob: (...a: unknown[]) => intake(...a) }));
import { fakeSupabase, ok, failure } from "@/test/fake-supabase";
import { prepareViaServerEnabled, submitViaPrintServer } from "./submit";

const session = { userId: "u1", membership: { organization_id: "org1", role: "staff", department: null } } as never;
const opts = { printerProfileId: "p1" } as never;
beforeEach(() => intake.mockReset().mockResolvedValue({ ok: true, prepareJobId: "prep-1" }));

describe("prepareViaServerEnabled", () => {
  it("is on only when the school's setting is exactly true; anything else (off, missing, read failure) is off", async () => {
    for (const [data, want] of [[{ prepare_via_server: true }, true], [{ prepare_via_server: false }, false], [null, false]] as const) {
      const f = fakeSupabase(() => ok(data));
      expect(await prepareViaServerEnabled(f.client as never, "org1")).toBe(want);
    }
    expect(await prepareViaServerEnabled(fakeSupabase(() => failure()).client as never, "org1")).toBe(false);
  });
});

describe("submitViaPrintServer", () => {
  it("uses the person's own staged upload as is", async () => {
    const path = "gateway-intake/u1/00000000-0000-4000-8000-000000000000.pdf";
    const f = fakeSupabase(() => ok());
    const out = await submitViaPrintServer(f.client as never, f.client as never, session, { stagedPath: path, fileName: "a.pdf" }, opts);
    expect(out).toEqual({ ok: true, prepareJobId: "prep-1" });
    expect(intake.mock.calls[0]![2]).toBe(path);
    expect(f.calls.some((c) => c.op === "upload")).toBe(false);
  });
  it("refuses someone else's staged path", async () => {
    const f = fakeSupabase(() => ok());
    const out = await submitViaPrintServer(f.client as never, f.client as never, session, { stagedPath: "gateway-intake/u2/00000000-0000-4000-8000-000000000000.pdf", fileName: "a.pdf" }, opts);
    expect(out).toMatchObject({ ok: false, code: "storage_failed" });
    expect(intake).not.toHaveBeenCalled();
  });
  it("stores a small file under the person's own prefix, then records the job", async () => {
    const f = fakeSupabase(() => ok());
    await submitViaPrintServer(f.client as never, f.client as never, session, { bytes: new Uint8Array([1, 2, 3]), fileName: "a.pdf" }, opts);
    const up = f.calls.find((c) => c.op === "upload")!;
    expect((up.values as { path: string }).path).toMatch(/^gateway-intake\/u1\/[0-9a-f-]{36}\.pdf$/);
    expect(intake.mock.calls[0]![2]).toBe((up.values as { path: string }).path);
  });
  it("a failed store stops before any job is recorded", async () => {
    const f = fakeSupabase(() => failure("down"));
    expect(await submitViaPrintServer(f.client as never, f.client as never, session, { bytes: new Uint8Array([1]), fileName: "a.pdf" }, opts)).toMatchObject({ ok: false, code: "storage_failed" });
    expect(intake).not.toHaveBeenCalled();
  });
  it("no file at all is a plain request to choose one", async () => {
    const f = fakeSupabase(() => ok());
    expect(await submitViaPrintServer(f.client as never, f.client as never, session, { fileName: "a.pdf" }, opts)).toMatchObject({ ok: false, code: "invalid_request" });
  });
});
