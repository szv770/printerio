import { describe, expect, it, vi } from "vitest";
import { createSignedIntakeStorage } from "../src/storage.js";

const PATH = "gateway-intake/11111111-1111-4111-8111-111111111111/a.pdf";

describe("signed intake storage", () => {
  it("uploads the bytes to the signed-upload URL of exactly that path, using the signed token and only the public key", async () => {
    const seen: { url: string; method: string; auth: string | null; apikey: string | null }[] = [];
    const f = vi.fn(async (url: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seen.push({ url: String(url), method: String(init?.method), auth: h.get("authorization"), apikey: h.get("apikey") });
      return new Response(JSON.stringify({ Key: `print-jobs/${PATH}` }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const sign = vi.fn(async () => "signed-token-1");
    const storage = createSignedIntakeStorage({ url: "https://sb.test", anonKey: "PUBLIC-ANON", sign, fetchImpl: f as unknown as typeof fetch });
    await storage.upload(PATH, Buffer.from("%PDF-1.7 test"));
    expect(sign).toHaveBeenCalledWith(PATH);
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.method).toBe("PUT");
    expect(req.url).toContain(`/storage/v1/object/upload/sign/print-jobs/${PATH}`);
    expect(req.url).toContain("token=signed-token-1");
    // Nothing but the public key is ever presented.
    expect(`${req.auth} ${req.apikey}`).not.toMatch(/service/i);
  });

  it("does not upload when the website refuses to sign", async () => {
    const f = vi.fn();
    const storage = createSignedIntakeStorage({
      url: "https://sb.test",
      anonKey: "PUBLIC-ANON",
      sign: async () => {
        throw new Error("refused");
      },
      fetchImpl: f as unknown as typeof fetch,
    });
    await expect(storage.upload(PATH, Buffer.from("x"))).rejects.toThrow("refused");
    expect(f).not.toHaveBeenCalled();
  });

  it("fails loudly when Supabase rejects the upload", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ message: "expired", statusCode: "400", error: "Bad" }), { status: 400, headers: { "content-type": "application/json" } }));
    const storage = createSignedIntakeStorage({ url: "https://sb.test", anonKey: "A", sign: async () => "t", fetchImpl: f as unknown as typeof fetch });
    await expect(storage.upload(PATH, Buffer.from("x"))).rejects.toThrow(/storage upload failed/);
  });
});
