import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { buildServiceWorkerSource } from "./sw-source";

const LIMIT = 1000;

type Listener = (e: unknown) => void;
function runWorker() {
  const listeners: Partial<Record<string, Listener>> = {};
  const calls: string[] = [];
  const sandbox = {
    self: {
      addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
      skipWaiting: () => calls.push("skipWaiting"),
      clients: {
        claim: () => {
          calls.push("claim");
          return Promise.resolve();
        },
      },
      location: { origin: "https://printio.test" },
    },
    URL,
    Response,
    Request,
    crypto: { randomUUID: () => "11111111-2222-3333-4444-555555555555" },
    Date,
    Promise,
    // The real IndexedDB is not available here: the worker must still answer.
    indexedDB: undefined as unknown,
  };
  vm.createContext(sandbox);
  vm.runInContext(buildServiceWorkerSource({ maxBytes: LIMIT }), sandbox);
  return { listeners: listeners as Record<string, Listener | undefined>, calls };
}

function fetchEvent(req: Request) {
  let responded: Promise<Response> | undefined;
  return {
    event: { request: req, respondWith: (p: Promise<Response> | Response) => (responded = Promise.resolve(p)) },
    get responded() {
      return responded;
    },
  };
}

describe("service worker source", () => {
  it("takes over immediately and has no caching code", () => {
    const src = buildServiceWorkerSource({ maxBytes: LIMIT });
    expect(src).not.toMatch(/caches\./);
    expect(src).toContain(String(LIMIT));
    const { listeners, calls } = runWorker();
    let waited: Promise<unknown> | undefined;
    listeners.install!({ waitUntil: (p: Promise<unknown>) => (waited = p) });
    listeners.activate!({ waitUntil: (p: Promise<unknown>) => (waited = p) });
    expect(calls).toEqual(["skipWaiting", "claim"]);
    expect(waited).toBeDefined();
  });

  it("does not touch ordinary requests", () => {
    const { listeners } = runWorker();
    for (const req of [
      new Request("https://printio.test/home"),
      new Request("https://printio.test/print", { method: "POST", body: "x" }),
      new Request("https://printio.test/share-target"), // GET
      new Request("https://other.test/share-target", { method: "POST", body: "x" }),
    ]) {
      const fe = fetchEvent(req);
      listeners.fetch!(fe.event);
      expect(fe.responded).toBeUndefined();
    }
  });

  it("answers POST /share-target with a 303, even when it cannot store the file", async () => {
    const { listeners } = runWorker();
    const form = new FormData();
    form.set("file", new File(["%PDF-1.4"], "a.pdf", { type: "application/pdf" }));
    const fe = fetchEvent(new Request("https://printio.test/share-target", { method: "POST", body: form }));
    listeners.fetch!(fe.event);
    const res = await fe.responded!;
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/print?share=storage");

    const big = new FormData();
    big.set("file", new File([new Uint8Array(LIMIT + 1)], "big.pdf", { type: "application/pdf" }));
    const fe2 = fetchEvent(new Request("https://printio.test/share-target", { method: "POST", body: big }));
    listeners.fetch!(fe2.event);
    expect((await fe2.responded!).headers.get("Location")).toBe("/print?share=toolarge");
  });
});
