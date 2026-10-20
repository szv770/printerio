import { describe, expect, it } from "vitest";
import { canTransition, isDeadEnd, isTerminalState, JOB_STATES } from "./job-state.js";

describe("job state machine", () => {
  it("never allows skipping straight from approved to completed", () => {
    expect(canTransition("approved", "completed")).toBe(false);
  });

  it("allows the full happy path one step at a time", () => {
    const happyPath = [
      "draft",
      "pending_approval",
      "approved",
      "claimed",
      "downloading",
      "downloaded",
      "printing",
      "submitted_to_spooler",
      "completed",
    ] as const;
    for (let i = 0; i < happyPath.length - 1; i++) {
      const from = happyPath[i]!;
      const to = happyPath[i + 1]!;
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it("allows a lease to expire back from claimed to approved", () => {
    expect(canTransition("claimed", "approved")).toBe(true);
  });

  it("allows a bounded retry from failed back into claimed", () => {
    expect(canTransition("failed", "claimed")).toBe(true);
  });

  it("terminal states are dead ends (no outgoing transitions)", () => {
    for (const state of JOB_STATES) {
      if (isTerminalState(state)) {
        expect(isDeadEnd(state)).toBe(true);
        for (const target of JOB_STATES) {
          expect(canTransition(state, target)).toBe(false);
        }
      }
    }
  });

  it("failed is retryable (not terminal) but still bounded to claimed/cancelled", () => {
    expect(isTerminalState("failed")).toBe(false);
    expect(isDeadEnd("failed")).toBe(false);
    expect(canTransition("failed", "claimed")).toBe(true);
    expect(canTransition("failed", "cancelled")).toBe(true);
    expect(canTransition("failed", "completed")).toBe(false);
  });

  it("draft cannot jump directly to claimed (must pass through approval)", () => {
    expect(canTransition("draft", "claimed")).toBe(false);
  });

  it("held: draft -> held, and held exits only to approval/denial/cancel/expiry", () => {
    expect(canTransition("draft", "held")).toBe(true);
    for (const to of JOB_STATES) {
      const legal = ["pending_approval", "approved", "denied", "cancelled", "expired"].includes(to);
      expect(canTransition("held", to)).toBe(legal);
    }
    expect(isTerminalState("held")).toBe(false);
    expect(isDeadEnd("held")).toBe(false);
  });

  it("held can only be entered from draft", () => {
    for (const from of JOB_STATES) {
      expect(canTransition(from, "held")).toBe(from === "draft");
    }
  });

  it("held never reaches the print pipeline directly", () => {
    expect(canTransition("held", "claimed")).toBe(false);
    expect(canTransition("held", "printing")).toBe(false);
  });
});
