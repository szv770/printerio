import { describe, expect, it } from "vitest";
import { decideRawFailure, decideDownloadFailure, PROFILE_COOLDOWN_MS } from "../src/retry-policy.js";
import type { RawFailure } from "../src/raw-print-executor.js";

/**
 * The release-vs-fail decision table. Owner decision: a printer that is off, offline, jammed, out of paper or busy
 * must NOT fail a job (the raw port buffers data and prints when ready), and neither must an unknown cause; only a
 * job that can never print fails straight away.
 */
describe("decideRawFailure", () => {
  const cases: Array<[string, RawFailure, ReturnType<typeof decideRawFailure>]> = [
    ["connect timed out", { kind: "connect_timeout" }, { action: "release", kind: "unavailable" }],
    ["connection refused (ECONNREFUSED)", { kind: "connect_refused", code: "ECONNREFUSED" }, { action: "release", kind: "unavailable" }],
    ["host unreachable (EHOSTUNREACH)", { kind: "connect_unreachable", code: "EHOSTUNREACH" }, { action: "release", kind: "unavailable" }],
    ["network unreachable (ENETUNREACH)", { kind: "connect_unreachable", code: "ENETUNREACH" }, { action: "release", kind: "unavailable" }],
    ["write stalled (printer buffer full / jam)", { kind: "write_timeout", bytesWritten: 1000 }, { action: "release", kind: "unavailable" }],
    ["every byte was sent and only the printer's close is missing (it may have the whole job: a re-send could print twice)", { kind: "write_timeout", bytesWritten: 5000, flushed: true }, { action: "fail" }],
    ["write stalled before a single byte went out", { kind: "write_timeout", bytesWritten: 0 }, { action: "release", kind: "unavailable" }],
    ["unknown socket error while connecting", { kind: "connect_error", code: "EWHATEVER" }, { action: "release", kind: "unknown" }],
    ["connection reset mid-write (ECONNRESET)", { kind: "write_error", code: "ECONNRESET", bytesWritten: 5 }, { action: "release", kind: "unknown" }],
    ["broken pipe mid-write (EPIPE)", { kind: "write_error", code: "EPIPE" }, { action: "release", kind: "unknown" }],
    ["the job itself cannot be built (bad PDF / impossible finishing)", { kind: "invalid_job" }, { action: "fail" }],
  ];
  it.each(cases)("%s", (_name, failure, expected) => {
    expect(decideRawFailure(failure)).toEqual(expected);
  });

  it("a failure we have never seen before is waited on as 'unknown', not failed", () => {
    expect(decideRawFailure({ kind: "something_new" } as unknown as RawFailure)).toEqual({ action: "release", kind: "unknown" });
  });
});

describe("decideDownloadFailure", () => {
  it("a network failure or a 5xx while fetching the document is transient: wait", () => {
    expect(decideDownloadFailure({ kind: "transient" })).toEqual({ action: "release", kind: "unknown" });
  });
  it("a missing/empty/non-PDF document is permanent: fail now with its message", () => {
    expect(decideDownloadFailure({ kind: "permanent" })).toEqual({ action: "fail" });
  });
});

describe("PROFILE_COOLDOWN_MS", () => {
  it("is the shortest backoff step, so one probe job per cooldown is the most the printer sees", () => {
    expect(PROFILE_COOLDOWN_MS).toBe(30_000);
  });
});
