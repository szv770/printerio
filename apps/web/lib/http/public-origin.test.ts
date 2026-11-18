import { afterEach, describe, expect, it } from "vitest";
import { isSameOrigin, publicOrigin } from "./public-origin";

const saved = process.env.NEXT_PUBLIC_APP_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = saved;
});

function req(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { method: "POST", headers });
}

describe("isSameOrigin", () => {
  it("accepts a request with no Origin header", () => {
    expect(isSameOrigin(req("https://beta.printio.app/x"))).toBe(true);
  });

  it("accepts the browser's https Origin when the server only sees plain http behind the tunnel", () => {
    const r = req("http://beta.printio.app/x", { origin: "https://beta.printio.app", "x-forwarded-proto": "https", host: "beta.printio.app" });
    expect(isSameOrigin(r)).toBe(true);
  });

  it("accepts the configured public app origin", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://beta.printio.app";
    const r = req("http://127.0.0.1:3010/x", { origin: "https://beta.printio.app" });
    expect(isSameOrigin(r)).toBe(true);
  });

  it("still refuses another site", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://beta.printio.app";
    const r = req("http://beta.printio.app/x", { origin: "https://evil.example", "x-forwarded-proto": "https", host: "beta.printio.app" });
    expect(isSameOrigin(r)).toBe(false);
  });
});

describe("publicOrigin", () => {
  it("prefers the forwarded https scheme over the internal http one", () => {
    expect(publicOrigin(req("http://beta.printio.app/x", { "x-forwarded-proto": "https", host: "beta.printio.app" }))).toBe("https://beta.printio.app");
  });
  it("falls back to the request URL", () => {
    expect(publicOrigin(req("https://printio.test/x"))).toBe("https://printio.test");
  });
});
