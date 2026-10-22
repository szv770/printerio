// Every request leaves a log line, so "Windows says it cannot connect" can be diagnosed from the gateway window.
import { afterEach, describe, expect, it } from "vitest";
import { attr, encodeIpp, OP, STATUS, TAG } from "../src/ipp/codec.js";
import { createLogger } from "../src/logger.js";
import { operationGroup, startHarness, type Harness } from "./helpers.js";

let h: Harness;
let lines: string[];
afterEach(async () => {
  await h.close();
});

async function start() {
  lines = [];
  h = await startHarness({ logger: createLogger("info", (l) => lines.push(l)) });
}
const entries = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
const printerUri = () => attr(TAG.uri, "printer-uri", `https://${h.host}/ipp/print`);

describe("request logging", () => {
  it("logs the request and the IPP reply, with the device token masked", async () => {
    await start();
    const r = await h.ipp({ code: OP.getPrinterAttributes, groups: [operationGroup(printerUri())] });
    expect(r.ipp.code).toBe(STATUS.ok);
    const req = entries().find((e) => e.msg === "request");
    const reply = entries().find((e) => e.msg === "reply");
    expect(req).toMatchObject({ method: "POST", path: "/ipp/print", userAgent: "test-client" });
    expect(String(req?.host)).toMatch(/^u-<token>\./);
    expect(reply).toMatchObject({ http: 200, ippStatus: STATUS.ok });
    expect(lines.join("\n")).not.toMatch(/u-[a-z2-7]{39}/i);
  });

  it("logs a request for a host that is not a device address, and why it was ignored", async () => {
    await start();
    const r = await h.post(encodeIpp({ code: OP.getPrinterAttributes, requestId: 1, groups: [operationGroup()] }), { host: "printio.szvtech.org" });
    expect(r.status).toBe(404);
    expect(entries().find((e) => e.msg === "ignored request")).toMatchObject({
      host: "printio.szvtech.org",
      reason: "not a device hostname",
    });
  });

  it("logs a GET that is not /healthz, naming the method", async () => {
    await start();
    const r = await h.post(Buffer.alloc(0), { method: "GET" });
    expect(r.status).toBe(404);
    expect(entries().find((e) => e.msg === "ignored request")).toMatchObject({ method: "GET", reason: "not an IPP POST" });
  });
});
