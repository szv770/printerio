import { describe, expect, it } from "vitest";
import { agentSupportsCheckOnly, deriveUpdateView, isUpdateLive, shouldAutoCheck, UPDATE_STEPS, type UpdateCommandRow } from "./update-progress";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const row = (o: Partial<UpdateCommandRow>): UpdateCommandRow => ({
  id: "c1",
  command: "CHECK_FOR_UPDATE",
  status: "pending",
  createdAt: ago(5),
  completedAt: null,
  result: null,
  checkOnly: false,
  ...o,
});
const view = (commands: UpdateCommandRow[], lastSeenAt: string | null = ago(3)) => deriveUpdateView({ commands, lastSeenAt, nowMs: NOW });
const states = (v: { steps: Array<{ state: string }> }) => v.steps.map((s) => s.state);

describe("deriveUpdateView - checking only", () => {
  it("is idle when nothing was ever requested (and other commands are ignored)", () => {
    expect(view([]).kind).toBe("idle");
    expect(view([row({ command: "GET_LOGS" })]).kind).toBe("idle");
  });
  it("shows a calm checking state while a check is waiting or running", () => {
    expect(view([row({ checkOnly: true })]).kind).toBe("checking");
    expect(view([row({ checkOnly: true, status: "acknowledged" })]).kind).toBe("checking");
  });
  it("shows the new version and what changed when an update is available", () => {
    const v = view([
      row({ checkOnly: true, status: "completed", completedAt: ago(2), result: { mode: "check_only", updateAvailable: true, latest: "8c4d0e2", latestMessage: "Faster booklets", behind: 3 } }),
    ]);
    expect(v).toMatchObject({ kind: "available", latest: "8c4d0e2", latestMessage: "Faster booklets", behind: 3 });
  });
  it("says up to date, with when it was checked", () => {
    const v = view([row({ checkOnly: true, status: "completed", completedAt: ago(2), result: { mode: "check_only", updateAvailable: false, current: "8c4d0e2" } })]);
    expect(v).toMatchObject({ kind: "up_to_date", checkedAt: ago(2) });
  });
  it("tolerates garbage results without throwing", () => {
    for (const result of [null, "x", 5, [], { updateAvailable: "yes" }, { updateAvailable: true, latest: { a: 1 }, behind: "many" }]) {
      expect(() => view([row({ checkOnly: true, status: "completed", completedAt: ago(1), result })])).not.toThrow();
    }
  });
  it("a check that cannot run (not a git checkout) is a soft problem in the agent's own words", () => {
    const v = view([row({ checkOnly: true, status: "completed", completedAt: ago(1), result: { updated: false, reason: "not_a_git_checkout", message: "Not a git clone." } })]);
    expect(v).toMatchObject({ kind: "check_failed", message: "Not a git clone." });
  });
  it("a failed check, or one nobody picked up for 3 minutes, is a soft could-not-check", () => {
    expect(view([row({ checkOnly: true, status: "failed", completedAt: ago(1) })]).kind).toBe("check_failed");
    expect(view([row({ checkOnly: true, createdAt: ago(200) })]).kind).toBe("check_failed");
  });
});

describe("deriveUpdateView - updating with live steps", () => {
  it("lists exactly the five plain steps in order", () => {
    expect(UPDATE_STEPS).toEqual(["checking", "downloading", "installing", "restarting", "done"]);
  });
  it("waiting for pickup shows the first step active", () => {
    const v = view([row({})]);
    expect(v.kind).toBe("updating");
    if (v.kind === "updating") expect(states(v)).toEqual(["active", "pending", "pending", "pending", "pending"]);
  });
  it("follows the step the agent reported, marking earlier ones done", () => {
    const v = view([row({ status: "acknowledged", result: { step: "installing" } })]);
    expect(v.kind).toBe("updating");
    if (v.kind === "updating") expect(states(v)).toEqual(["done", "done", "active", "pending", "pending"]);
  });
  it("ignores an unknown or hostile step name", () => {
    const v = view([row({ status: "acknowledged", result: { step: "rm -rf" } })]);
    expect(v.kind).toBe("updating");
    if (v.kind === "updating") expect(states(v)[0]).toBe("active");
  });
  it("after the agent says it is done but before it reconnects, shows Restarting (a quiet agent is expected)", () => {
    const v = view([row({ status: "completed", createdAt: ago(60), completedAt: ago(20), result: { updated: true, reason: "updated", from: "3f2a1b9", to: "8c4d0e2" } })], ago(25));
    expect(v.kind).toBe("restarting");
    if (v.kind === "restarting") expect(states(v)).toEqual(["done", "done", "done", "active", "pending"]);
  });
  it("is done once the agent checks in again after the update, naming the new version", () => {
    const v = view([row({ status: "completed", createdAt: ago(100), completedAt: ago(40), result: { updated: true, reason: "updated", from: "3f2a1b9", to: "8c4d0e2" } })], ago(5));
    expect(v).toMatchObject({ kind: "done", to: "8c4d0e2", from: "3f2a1b9" });
    if (v.kind === "done") expect(states(v)).toEqual(["done", "done", "done", "done", "done"]);
  });
  it("never reconnecting for 6 minutes becomes a clear failure at the restart step", () => {
    const v = view([row({ status: "completed", createdAt: ago(900), completedAt: ago(400), result: { updated: true, reason: "updated", to: "8c4d0e2" } })], ago(500));
    expect(v.kind).toBe("failed");
    if (v.kind === "failed") expect(v.message).toMatch(/did not come back/i);
  });
  it("already up to date from a full update is simply up to date", () => {
    const v = view([row({ status: "completed", completedAt: ago(2), result: { updated: false, reason: "already_up_to_date", message: "Already up to date." } })]);
    expect(v.kind).toBe("up_to_date");
  });
  it("a failure keeps the agent's plain message, marks the failing step and offers retry", () => {
    const v = view([row({ status: "completed", completedAt: ago(2), result: { updated: false, reason: "install_failed", step: "installing", message: "pnpm install failed." } })]);
    expect(v.kind).toBe("failed");
    if (v.kind === "failed") {
      expect(v.message).toBe("pnpm install failed.");
      expect(v.steps.find((s) => s.id === "installing")?.state).toBe("failed");
      expect(v.steps.find((s) => s.id === "checking")?.state).toBe("done");
    }
  });
  it("a command the agent marked failed is a failure", () => {
    expect(view([row({ status: "failed", completedAt: ago(1), result: { reason: "handler_exception" } })]).kind).toBe("failed");
  });
  it("running for over 15 minutes, or never picked up for 5, is a failure not an eternal spinner", () => {
    expect(view([row({ status: "acknowledged", createdAt: ago(1000) })]).kind).toBe("failed");
    expect(view([row({ createdAt: ago(400) })]).kind).toBe("failed");
  });
  it("the newest request decides: a fresh check after a finished update shows the check", () => {
    const v = view([
      row({ id: "n", checkOnly: true, status: "completed", completedAt: ago(1), createdAt: ago(2), result: { updateAvailable: false } }),
      row({ id: "o", status: "completed", createdAt: ago(900), completedAt: ago(800), result: { updated: true, to: "8c4d0e2" } }),
    ]);
    expect(v.kind).toBe("up_to_date");
  });
});

describe("shouldAutoCheck", () => {
  it("checks when nothing was ever requested", () => {
    expect(shouldAutoCheck({ commands: [], lastSeenAt: ago(3), nowMs: NOW, agentVersion: "0.2.0" })).toBe(true);
  });
  it("does not stack a check on one in flight or a running update", () => {
    expect(shouldAutoCheck({ commands: [row({ checkOnly: true })], lastSeenAt: ago(3), nowMs: NOW, agentVersion: "0.2.0" })).toBe(false);
    expect(shouldAutoCheck({ commands: [row({ status: "acknowledged" })], lastSeenAt: ago(3), nowMs: NOW, agentVersion: "0.2.0" })).toBe(false);
  });
  it("reuses a result younger than 10 minutes, re-checks an older one", () => {
    const fresh = row({ checkOnly: true, status: "completed", createdAt: ago(120), completedAt: ago(110), result: { updateAvailable: false } });
    const old = row({ checkOnly: true, status: "completed", createdAt: ago(1200), completedAt: ago(1190), result: { updateAvailable: false } });
    expect(shouldAutoCheck({ commands: [fresh], lastSeenAt: ago(3), nowMs: NOW, agentVersion: "0.2.0" })).toBe(false);
    expect(shouldAutoCheck({ commands: [old], lastSeenAt: ago(3), nowMs: NOW, agentVersion: "0.2.0" })).toBe(true);
  });
  it("does not check an agent that has been silent for over 2 minutes (it could not answer)", () => {
    expect(shouldAutoCheck({ commands: [], lastSeenAt: ago(600), nowMs: NOW, agentVersion: "0.2.0" })).toBe(false);
    expect(shouldAutoCheck({ commands: [], lastSeenAt: null, nowMs: NOW, agentVersion: "0.2.0" })).toBe(false);
  });
  it("leaves a just-finished update's Updated-to message alone for a while", () => {
    const done = row({ status: "completed", createdAt: ago(200), completedAt: ago(100), result: { updated: true, to: "8c4d0e2" } });
    expect(shouldAutoCheck({ commands: [done], lastSeenAt: ago(3), nowMs: NOW, agentVersion: "0.2.0" })).toBe(false);
  });
});

describe("check-only capability (an old agent would treat check_only as a full update)", () => {
  it("only agents that reported version 0.2.0 or newer support it", () => {
    expect(agentSupportsCheckOnly("0.1.0")).toBe(false);
    expect(agentSupportsCheckOnly("0.1.9")).toBe(false);
    expect(agentSupportsCheckOnly(null)).toBe(false);
    expect(agentSupportsCheckOnly("")).toBe(false);
    expect(agentSupportsCheckOnly("0.2.0")).toBe(true);
    expect(agentSupportsCheckOnly("0.10.0")).toBe(true);
    expect(agentSupportsCheckOnly("1.0.0")).toBe(true);
  });
  it("never auto-checks an agent that has not proven the capability, even when idle and online", () => {
    expect(shouldAutoCheck({ commands: [], lastSeenAt: ago(3), nowMs: NOW, agentVersion: "0.1.0" })).toBe(false);
    expect(shouldAutoCheck({ commands: [], lastSeenAt: ago(3), nowMs: NOW, agentVersion: null })).toBe(false);
  });
  it("auto-checks a capable agent", () => {
    expect(shouldAutoCheck({ commands: [], lastSeenAt: ago(3), nowMs: NOW, agentVersion: "0.2.0" })).toBe(true);
  });
});

describe("legacy (0.1.0) agent: the banner follows the RUNNING version, never a stale already-up-to-date row", () => {
  const staleCurrent = row({ status: "completed", createdAt: ago(7200), completedAt: ago(7190), result: { updated: false, reason: "already_up_to_date", message: "Already up to date." } });
  const v = (commands: UpdateCommandRow[], agentVersion: string | null, lastSeenAt: string | null = ago(3)) =>
    deriveUpdateView({ commands, lastSeenAt, nowMs: NOW, agentVersion, latestVersion: "0.2.0" });

  it("no rows and an old version: update available, naming both versions", () => {
    expect(v([], "0.1.0")).toMatchObject({ kind: "outdated", running: "0.1.0", latest: "0.2.0" });
  });
  it("a stale already-up-to-date answer does NOT make an outdated server look current (needs a restart instead)", () => {
    expect(v([staleCurrent], "0.1.0")).toMatchObject({ kind: "restart_needed", running: "0.1.0", latest: "0.2.0" });
  });
  it("an unknown version is treated as not provably current", () => {
    expect(v([], null).kind).toBe("outdated");
  });
  it("a legacy agent that is on the newest version is simply up to date, with no check time", () => {
    expect(deriveUpdateView({ commands: [], lastSeenAt: ago(3), nowMs: NOW, agentVersion: "0.1.0", latestVersion: "0.1.0" })).toEqual({ kind: "up_to_date", checkedAt: null });
  });
  it("a check_only row left over from an old agent that ran a full update is read as a full update", () => {
    const left = row({ checkOnly: true, status: "completed", createdAt: ago(100), completedAt: ago(40), result: { updated: true, reason: "updated", to: "8c4d0e2" } });
    expect(v([left], "0.1.0", ago(5)).kind).toBe("done");
  });
  it("running updates still show live steps for a legacy agent", () => {
    expect(v([row({ status: "acknowledged", result: { step: "installing" } })], "0.1.0").kind).toBe("updating");
  });
  it("a capable agent's own up-to-date answer stays up to date when its version is current", () => {
    const r = row({ checkOnly: true, status: "completed", completedAt: ago(2), result: { updateAvailable: false, reason: "up_to_date" } });
    expect(v([r], "0.2.0").kind).toBe("up_to_date");
  });
});

describe("restart-only path (RESTART_AGENT_SERVICE) for a downloaded-but-not-running update", () => {
  const rs = (o: Partial<UpdateCommandRow>) => row({ id: "r1", command: "RESTART_AGENT_SERVICE", ...o });
  const v = (commands: UpdateCommandRow[], agentVersion: string | null, lastSeenAt: string | null) =>
    deriveUpdateView({ commands, lastSeenAt, nowMs: NOW, agentVersion, latestVersion: "0.2.0" });

  it("while the restart is waiting or just done but not back, shows Restarting", () => {
    expect(v([rs({ status: "pending", createdAt: ago(10) })], "0.1.0", ago(20)).kind).toBe("restarting");
    expect(v([rs({ status: "completed", createdAt: ago(30), completedAt: ago(20) })], "0.1.0", ago(25)).kind).toBe("restarting");
  });
  it("back on the new version: done, naming it", () => {
    expect(v([rs({ status: "completed", createdAt: ago(60), completedAt: ago(40) })], "0.2.0", ago(5))).toMatchObject({ kind: "done", to: "0.2.0" });
  });
  it("back but still on the old version: an honest failure, not a fake success", () => {
    const r = v([rs({ status: "completed", createdAt: ago(60), completedAt: ago(40) })], "0.1.0", ago(5));
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.message).toMatch(/0\.1\.0/);
  });
  it("an old unrelated restart (over 10 minutes) is ignored", () => {
    expect(v([rs({ status: "completed", createdAt: ago(3000), completedAt: ago(2990) })], "0.2.0", ago(5)).kind).toBe("idle");
  });
  it("is live while restarting", () => {
    expect(isUpdateLive(v([rs({ status: "pending", createdAt: ago(10) })], "0.1.0", ago(20)))).toBe(true);
  });
});
