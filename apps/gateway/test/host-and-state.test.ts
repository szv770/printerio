import { describe, expect, it } from "vitest";
import { JOB_STATES } from "@printio/shared";
import { deviceHostname, generateDeviceToken, hashDeviceToken, tokenFromHost } from "@printio/shared/device-token";
import { mapJobState } from "../src/handlers.js";
import { JobRegistry, PENDING_TTL_MS } from "../src/job-registry.js";
import { maskTokens } from "../src/logger.js";

describe("Host parsing", () => {
  const token = generateDeviceToken();
  it("round-trips token -> hostname -> token -> hash", () => {
    const host = deviceHostname(token, "szvtech.org");
    expect(tokenFromHost(host, "szvtech.org")).toBe(token);
    expect(hashDeviceToken(tokenFromHost(host, "szvtech.org") as string)).toBe(hashDeviceToken(token));
  });
  it("accepts a port and upper case", () => {
    const host = `U-${token.toUpperCase()}.SZVTECH.ORG:8631`;
    expect(tokenFromHost(host, "szvtech.org")).toBe(token);
  });
  it("rejects other hosts", () => {
    expect(tokenFromHost("localhost:8631", "szvtech.org")).toBeNull();
    expect(tokenFromHost(`u-${token}.evil.org`, "szvtech.org")).toBeNull();
    expect(tokenFromHost(`u-${token.slice(1)}.szvtech.org`, "szvtech.org")).toBeNull();
    expect(tokenFromHost(undefined, "szvtech.org")).toBeNull();
    expect(tokenFromHost("szvtech.org", "szvtech.org")).toBeNull();
  });
  it("masks tokens in log text", () => {
    expect(maskTokens(`GET u-${token}.szvtech.org`)).toBe("GET u-<token>.szvtech.org");
  });
});

describe("JobState -> IPP mapping", () => {
  const expected: Record<string, [number, string]> = {
    draft: [4, "job-hold-until-specified"],
    held: [4, "job-hold-until-specified"],
    pending_approval: [4, "job-hold-until-specified"],
    approved: [3, "job-queued"],
    claimed: [3, "job-queued"],
    downloading: [3, "job-queued"],
    downloaded: [3, "job-queued"],
    printing: [5, "job-printing"],
    submitted_to_spooler: [5, "job-printing"],
    completed: [9, "job-completed-successfully"],
    cancelled: [7, "job-canceled-by-user"],
    denied: [8, "aborted-by-system"],
    rejected: [8, "aborted-by-system"],
    expired: [8, "aborted-by-system"],
    failed: [8, "aborted-by-system"],
  };
  it("covers every JobState exactly as the contract says", () => {
    expect(Object.keys(expected).sort()).toEqual([...JOB_STATES].sort());
    for (const s of JOB_STATES) {
      const m = mapJobState(s);
      expect([m.state, m.reason]).toEqual(expected[s]);
    }
  });
  it("never reports an unknown future state as finished", () => {
    expect(mapJobState("something_new" as never).state).toBe(4);
  });
});

describe("JobRegistry", () => {
  it("expires Create-Job state after 10 minutes", () => {
    let t = 1_000;
    const r = new JobRegistry(() => t);
    const e = r.createPending("d", { name: "n", userName: "u", attributes: {} });
    expect(r.get("d", e.ippId)).toBeDefined();
    t += PENDING_TTL_MS - 1;
    expect(r.get("d", e.ippId)).toBeDefined();
    t += 2;
    expect(r.get("d", e.ippId)).toBeUndefined();
  });
  it("keeps devices apart", () => {
    const r = new JobRegistry();
    const e = r.createPending("a", { name: "n", userName: "u", attributes: {} });
    expect(r.get("b", e.ippId)).toBeUndefined();
  });
});
