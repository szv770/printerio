import { describe, expect, it } from "vitest";
import {
  auditSafeResult,
  commandPhase,
  hasActiveCommand,
  parseCommandResult,
  AUTO_REFRESH_RECENT_MS,
} from "./command-result";

describe("parseCommandResult (tolerant: the Agent writes this jsonb, it is never trusted)", () => {
  it.each([null, undefined, 5, "text", true, [], [1, 2], {}])("never throws and yields an empty parse for %j", (input) => {
    const p = parseCommandResult(input);
    expect(p.message).toBeNull();
    expect(p.files).toEqual([]);
    expect(p.notes).toEqual([]);
  });

  it("reads message, updated and reason when they are the right type, and ignores them otherwise", () => {
    expect(parseCommandResult({ message: "Updated", updated: true, reason: "updated" })).toMatchObject({
      message: "Updated",
      updated: true,
      reason: "updated",
    });
    expect(parseCommandResult({ message: 5, updated: "yes", reason: {} })).toMatchObject({ message: null, updated: null, reason: null });
    expect(parseCommandResult({ message: "   " }).message).toBeNull();
  });

  it("keeps only well-formed log files and coerces lines to strings", () => {
    const p = parseCommandResult({
      files: [
        { name: "agent/a.log", lines: ["one", 2, null, "three"] },
        { name: 7, lines: ["x"] },
        { name: "no-lines" },
        "garbage",
        null,
        { name: "b.log", lines: "not an array" },
      ],
      notes: ["n1", 3, "n2"],
    });
    expect(p.files).toEqual([{ name: "agent/a.log", lines: ["one", "2", "three"] }]);
    expect(p.notes).toEqual(["n1", "n2"]);
  });

  it("bounds what a hostile or buggy result can make the page render", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `l${i}`);
    const files = Array.from({ length: 50 }, (_, i) => ({ name: `f${i}`, lines }));
    const p = parseCommandResult({ files });
    expect(p.files.length).toBeLessThanOrEqual(6);
    expect(p.files[0]!.lines.length).toBeLessThanOrEqual(400);
  });
});

describe("auditSafeResult", () => {
  it("never copies log content into audit_logs: GET_LOGS keeps only counts", () => {
    const out = auditSafeResult("GET_LOGS", { files: [{ name: "a", lines: ["secret line", "b"] }], notes: ["x"] });
    expect(JSON.stringify(out)).not.toContain("secret line");
    expect(out).toEqual({ files: 1, lines: 2 });
  });

  it("keeps small plain results for other commands and drops oversized ones", () => {
    expect(auditSafeResult("CHECK_FOR_UPDATE", { updated: true, reason: "updated", message: "Updated a -> b." })).toEqual({
      updated: true,
      reason: "updated",
      message: "Updated a -> b.",
    });
    expect(auditSafeResult("REFRESH_PRINTER_STATUS", { blob: "x".repeat(10_000) })).toEqual({ omitted: "result too large for the audit log" });
    expect(auditSafeResult("RESTART_AGENT_SERVICE", null)).toBeNull();
  });
});

describe("commandPhase", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const base = { id: "1", command: "CHECK_FOR_UPDATE", createdAt: "2026-10-23T11:59:50Z", completedAt: null as string | null, result: null as unknown };

  it("says it is waiting for the print server while pending", () => {
    expect(commandPhase({ ...base, status: "pending" }, now)).toEqual({
      kind: "waiting",
      text: "Waiting for the print server to pick it up (it checks about every 15 seconds)",
    });
  });

  it("says Running... once the agent has picked it up", () => {
    expect(commandPhase({ ...base, status: "acknowledged" }, now)).toEqual({ kind: "running", text: "Running..." });
  });

  it("shows the agent's own message when finished, or a plain fallback", () => {
    expect(commandPhase({ ...base, status: "completed", result: { message: "All good." } }, now)).toEqual({ kind: "done", text: "All good." });
    expect(commandPhase({ ...base, status: "completed" }, now)).toEqual({ kind: "done", text: "Done." });
    expect(commandPhase({ ...base, status: "failed" }, now).text).toMatch(/did not complete/i);
  });

  it("tells the admin when a request has waited too long", () => {
    const old = { ...base, status: "pending", createdAt: "2026-10-23T11:50:00Z" };
    expect(commandPhase(old, now).text).toMatch(/offline|not picked it up/i);
  });

  it("copes with an unknown status or a garbage timestamp", () => {
    expect(commandPhase({ ...base, status: "weird", createdAt: "nonsense" }, now).kind).toBe("unknown");
  });
});

describe("hasActiveCommand (drives the live refresh)", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const cmd = (status: string, ageMs: number) => ({ status, createdAt: new Date(now - ageMs).toISOString() });

  it("is true while anything is pending or running", () => {
    expect(hasActiveCommand([cmd("pending", 10 * 60_000)], now)).toBe(true);
    expect(hasActiveCommand([cmd("acknowledged", 10 * 60_000)], now)).toBe(true);
  });

  it("gives up on a request nobody picked up for 30 minutes (server off) so the page does not poll all day", () => {
    expect(hasActiveCommand([cmd("pending", 31 * 60_000)], now)).toBe(false);
  });

  it("is true for a finished command created in the last 2 minutes (the page may not have caught the result yet)", () => {
    expect(AUTO_REFRESH_RECENT_MS).toBe(120_000);
    expect(hasActiveCommand([cmd("completed", 60_000)], now)).toBe(true);
    expect(hasActiveCommand([cmd("completed", 121_000)], now)).toBe(false);
  });

  it("is false for nothing / old finished commands / garbage dates", () => {
    expect(hasActiveCommand([], now)).toBe(false);
    expect(hasActiveCommand([cmd("failed", 10 * 60_000)], now)).toBe(false);
    expect(hasActiveCommand([{ status: "completed", createdAt: "garbage" }], now)).toBe(false);
  });
});
