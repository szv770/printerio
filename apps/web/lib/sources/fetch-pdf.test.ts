import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { fetchPdf, fileNameFrom, resolveWithRetry, type Resolver, type Transport, type TransportResponse } from "./fetch-pdf";

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

function reply(status: number, body: Uint8Array | string = "", headers: Record<string, string> = {}): TransportResponse {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  let destroyed = false;
  return {
    status,
    headers,
    body: (async function* () {
      // two chunks, so the streaming path is exercised
      const mid = Math.floor(bytes.length / 2);
      if (!destroyed && mid > 0) yield bytes.subarray(0, mid);
      if (!destroyed) yield bytes.subarray(mid);
    })(),
    destroy: () => {
      destroyed = true;
    },
  };
}

const publicDns: Resolver = async () => ["142.250.80.46"];
const url = (s: string) => new URL(s);

describe("fetchPdf: success", () => {
  it("returns the bytes and a file name from Content-Disposition", async () => {
    const seen: Array<{ ip: string; hostname: string; path: string; host: string }> = [];
    const transport: Transport = async (r) => {
      seen.push({ ip: r.ip, hostname: r.hostname, path: r.path, host: r.headers.Host! });
      return reply(200, PDF, { "content-disposition": "attachment; filename=\"Likkutei Sichos 1.pdf\"" });
    };
    const res = await fetchPdf(url("https://drive.usercontent.google.com/download?id=abc"), "drive", { resolve: publicDns, transport });
    expect(res).toMatchObject({ ok: true, fileName: "Likkutei Sichos 1.pdf" });
    expect(res.ok && Array.from(res.bytes)).toEqual(Array.from(PDF));
    // the connection goes to the address that was checked, with the real name for the certificate and Host header
    expect(seen[0]).toEqual({ ip: "142.250.80.46", hostname: "drive.usercontent.google.com", path: "/download?id=abc", host: "drive.usercontent.google.com" });
  });

  it("accepts a PDF header after a little leading junk, and ignores the content type the server claims", async () => {
    const junk = new TextEncoder().encode("\r\n\r\n%PDF-1.4\nbody");
    const res = await fetchPdf(url("https://example.org/a"), "direct", { resolve: publicDns, transport: async () => reply(200, junk, { "content-type": "text/plain" }) });
    expect(res.ok).toBe(true);
  });

  it("follows redirects, checking every hop", async () => {
    const calls: string[] = [];
    const transport: Transport = async (r) => {
      calls.push(r.hostname);
      return r.hostname === "a.example.org" ? reply(302, "", { location: "https://b.example.org/file.pdf" }) : reply(200, PDF);
    };
    const res = await fetchPdf(url("https://a.example.org/x"), "direct", { resolve: publicDns, transport });
    expect(res).toMatchObject({ ok: true, fileName: "file.pdf" });
    expect(calls).toEqual(["a.example.org", "b.example.org"]);
  });
});

describe("fetchPdf: it never reaches inside our own network", () => {
  it("refuses a name that resolves to a private address, without connecting", async () => {
    const transport = vi.fn();
    const res = await fetchPdf(url("https://sneaky.example.org/a.pdf"), "direct", { resolve: async () => ["10.0.0.7"], transport });
    expect(res).toMatchObject({ ok: false, reason: "blocked" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses when ANY of several answers is private (DNS rebinding tricks)", async () => {
    const transport = vi.fn();
    const res = await fetchPdf(url("https://sneaky.example.org/a.pdf"), "direct", { resolve: async () => ["8.8.8.8", "169.254.169.254"], transport });
    expect(res).toMatchObject({ ok: false, reason: "blocked" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses a redirect that points at an internal address or name", async () => {
    for (const target of ["https://169.254.169.254/latest/meta-data", "https://localhost/admin", "http://example.org/a.pdf", "https://example.org:8443/a.pdf", "https://user:pw@example.org/a.pdf"]) {
      const transport = vi.fn(async () => reply(302, "", { location: target }));
      const res = await fetchPdf(url("https://a.example.org/x"), "direct", { resolve: publicDns, transport });
      expect(res.ok).toBe(false);
      expect(transport).toHaveBeenCalledTimes(1); // the second hop was never made
    }
  });

  it("refuses a redirect to a name that resolves to a private address", async () => {
    const resolve: Resolver = async (h) => (h === "a.example.org" ? ["8.8.8.8"] : ["192.168.1.5"]);
    const transport = vi.fn(async () => reply(302, "", { location: "https://inside.example.org/p.pdf" }));
    const res = await fetchPdf(url("https://a.example.org/x"), "direct", { resolve, transport });
    expect(res).toMatchObject({ ok: false, reason: "blocked" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("gives up on a redirect loop", async () => {
    const transport = vi.fn(async () => reply(302, "", { location: "https://a.example.org/again" }));
    const res = await fetchPdf(url("https://a.example.org/x"), "direct", { resolve: publicDns, transport });
    expect(res).toMatchObject({ ok: false, reason: "http" });
    expect(transport.mock.calls.length).toBeLessThanOrEqual(6);
  });
});

describe("fetchPdf: what is not a PDF, or not allowed", () => {
  it("a Google sign-in page gets a plain Drive explanation", async () => {
    const res = await fetchPdf(url("https://drive.usercontent.google.com/download?id=abc"), "drive", {
      resolve: publicDns,
      transport: async () => reply(200, "<!DOCTYPE html><html><body>Sign in</body></html>", { "content-type": "text/html" }),
    });
    expect(res).toMatchObject({ ok: false, reason: "not_pdf" });
    expect(!res.ok && res.message).toMatch(/anyone with the link/i);
  });

  it("an ordinary web page is refused as a web page", async () => {
    const res = await fetchPdf(url("https://example.org/article"), "direct", { resolve: publicDns, transport: async () => reply(200, "<html><body>hi</body></html>") });
    expect(res).toMatchObject({ ok: false, reason: "not_pdf" });
    expect(!res.ok && res.message).toMatch(/web page/i);
  });

  it("other files, and empty answers, are refused", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect((await fetchPdf(url("https://example.org/a"), "direct", { resolve: publicDns, transport: async () => reply(200, png) })).ok).toBe(false);
    expect((await fetchPdf(url("https://example.org/a"), "direct", { resolve: publicDns, transport: async () => reply(200, "") })).ok).toBe(false);
  });

  it.each([
    [403, "not_shared"],
    [401, "not_shared"],
    [404, "not_found"],
    [410, "not_found"],
    [429, "rate_limited"],
    [500, "http"],
  ])("status %i -> %s", async (status, reason) => {
    const res = await fetchPdf(url("https://example.org/a"), "direct", { resolve: publicDns, transport: async () => reply(status as number) });
    expect(res).toMatchObject({ ok: false, reason });
  });

  it("a name that does not exist is a plain network message", async () => {
    const res = await fetchPdf(url("https://nope.example.org/a"), "direct", {
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
      transport: vi.fn(),
    });
    expect(res).toMatchObject({ ok: false, reason: "network" });
  });
});

describe("fetchPdf: size and time limits", () => {
  it("refuses a file whose declared size is over the limit before reading it", async () => {
    const res = await fetchPdf(url("https://example.org/a"), "direct", {
      maxBytes: 1000,
      resolve: publicDns,
      transport: async () => reply(200, PDF, { "content-length": "99999" }),
    });
    expect(res).toMatchObject({ ok: false, reason: "too_big" });
  });

  it("stops reading a stream that grows past the limit even when it lies about its size", async () => {
    const big = new Uint8Array(5000);
    big.set(PDF, 0);
    const res = await fetchPdf(url("https://example.org/a"), "direct", { maxBytes: 1000, resolve: publicDns, transport: async () => reply(200, big) });
    expect(res).toMatchObject({ ok: false, reason: "too_big" });
  });

  it("aborts the request it gave up on, so nothing is left running", async () => {
    let seen: AbortSignal | undefined;
    const res = await fetchPdf(url("https://example.org/a"), "direct", {
      timeoutMs: 60,
      resolve: publicDns,
      transport: (r) => {
        seen = r.signal;
        return new Promise(() => {});
      },
    });
    expect(res).toMatchObject({ ok: false, reason: "timeout" });
    expect(seen?.aborted).toBe(true);
  });

  it("times out a server that never answers", async () => {
    const res = await fetchPdf(url("https://example.org/a"), "direct", { timeoutMs: 60, resolve: publicDns, transport: () => new Promise(() => {}) });
    expect(res).toMatchObject({ ok: false, reason: "timeout" });
  });
});

describe("resolveWithRetry", () => {
  it("tries once more after a temporary failure, and not after a real one", async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("again"), { code: "EAI_AGAIN" });
      return ["8.8.8.8"];
    };
    expect(await resolveWithRetry(flaky, "example.org")).toEqual(["8.8.8.8"]);
    expect(calls).toBe(2);

    let missing = 0;
    const gone = async () => {
      missing++;
      throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
    };
    await expect(resolveWithRetry(gone, "nope.example.org")).rejects.toThrow("nx");
    expect(missing).toBe(1);
  });
});

describe("fileNameFrom", () => {
  const u = (s: string) => new URL(s);
  it("prefers the UTF-8 name, cleans odd characters, and always ends in .pdf", () => {
    expect(fileNameFrom("attachment; filename*=UTF-8''%D7%A9%D7%99%D7%97%D7%94.pdf", u("https://x.org/a"))).toBe("שיחה.pdf");
    expect(fileNameFrom('attachment; filename="a/b\\c:d.pdf"', u("https://x.org/a"))).toBe("a b c d.pdf");
    expect(fileNameFrom('attachment; filename="notes"', u("https://x.org/a"))).toBe("notes.pdf");
  });
  it("reads a Hebrew name the server sent as raw UTF-8 bytes (Node hands headers over as Latin-1 text)", () => {
    const raw = Buffer.from("01 יום א' דראש השנה.pdf", "utf8").toString("latin1");
    expect(fileNameFrom(`attachment; filename="${raw}"`, u("https://x.org/a"))).toBe("01 יום א' דראש השנה.pdf");
    // plain Latin-1 text that is not UTF-8 stays as it is
    const plain = Buffer.from("café.pdf", "latin1").toString("latin1");
    expect(fileNameFrom(`attachment; filename="${plain}"`, u("https://x.org/a"))).toBe(plain);
  });
  it("falls back to the end of the address when it is a .pdf, otherwise nothing", () => {
    expect(fileNameFrom(undefined, u("https://x.org/files/Booklet%201.pdf"))).toBe("Booklet 1.pdf");
    expect(fileNameFrom(undefined, u("https://x.org/download?id=1"))).toBeNull();
  });
});
