import { describe, expect, it, vi } from "vitest";
import { stageLargeFile, UPLOAD_NETWORK_FAILED } from "./direct-upload";

const file = new File([new Uint8Array(10)], "big.pdf", { type: "application/pdf" });

describe("stageLargeFile", () => {
  it("gets a slot, uploads straight to storage and returns the staged path", async () => {
    const getSlot = vi.fn(async (_n: number) => ({ ok: true as const, path: "gateway-intake/u/x.pdf", token: "t" }));
    const upload = vi.fn(async () => ({ error: null }));
    const r = await stageLargeFile(file, { getSlot, upload });
    expect(r).toEqual({ ok: true, path: "gateway-intake/u/x.pdf" });
    expect(getSlot).toHaveBeenCalledWith(10);
    expect(upload).toHaveBeenCalledWith("gateway-intake/u/x.pdf", "t", file);
  });
  it("passes the server's refusal through unchanged (not a network problem)", async () => {
    const upload = vi.fn();
    const r = await stageLargeFile(file, { getSlot: async () => ({ ok: false as const, error: "This file is larger than the 50 MB limit." }), upload });
    expect(r).toEqual({ ok: false, error: "This file is larger than the 50 MB limit." });
    expect(upload).not.toHaveBeenCalled();
  });
  it("tells a dropped connection apart from a server rejection", async () => {
    const down = await stageLargeFile(file, { getSlot: async () => ({ ok: true as const, path: "p", token: "t" }), upload: async () => { throw new TypeError("Failed to fetch"); } });
    expect(down).toEqual({ ok: false, error: UPLOAD_NETWORK_FAILED });
    const rejected = await stageLargeFile(file, { getSlot: async () => ({ ok: true as const, path: "p", token: "t" }), upload: async () => ({ error: { message: "The object exceeded the maximum allowed size" } }) });
    expect(rejected.ok).toBe(false);
    expect(!rejected.ok && rejected.error).toMatch(/storage refused/i);
  });
  it("reports a failing slot request (server unreachable) as a connection problem", async () => {
    const r = await stageLargeFile(file, { getSlot: async () => { throw new Error("fetch failed"); }, upload: vi.fn() });
    expect(r).toEqual({ ok: false, error: UPLOAD_NETWORK_FAILED });
  });
});
