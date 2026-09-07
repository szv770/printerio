import { describe, expect, it } from "vitest";
import { compareAgentVersions } from "@printio/shared";
import {
  AGENT_ONLINE_WINDOW_MS,
  describeAgentConnection,
  describeAgentVersion,
  deriveAgentActivity,
  isAgentOnline,
  summarizeQueueUsage,
  summarizeUsageByProfile,
} from "./agent-detail";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

describe("summarizeQueueUsage", () => {
  it("counts every job sent, separately from the ones that actually reached the printer", () => {
    const usage = summarizeQueueUsage([
      { created_at: minutesAgo(60), status: "completed" },
      { created_at: minutesAgo(30), status: "submitted_to_spooler" },
      { created_at: minutesAgo(10), status: "failed" },
      { created_at: minutesAgo(5), status: "pending_approval" },
    ]);
    expect(usage.totalJobs).toBe(4);
    expect(usage.printedJobs).toBe(2);
    expect(usage.lastUsedAt).toBe(minutesAgo(5));
  });

  it("reports a never-used queue honestly rather than as zero-with-a-timestamp", () => {
    expect(summarizeQueueUsage([])).toEqual({ totalJobs: 0, printedJobs: 0, lastUsedAt: null });
  });

  it("takes the newest created_at regardless of input order", () => {
    const usage = summarizeQueueUsage([
      { created_at: minutesAgo(5), status: "completed" },
      { created_at: minutesAgo(90), status: "completed" },
    ]);
    expect(usage.lastUsedAt).toBe(minutesAgo(5));
  });
});

describe("summarizeUsageByProfile", () => {
  it("includes profiles with no jobs at all, so an unused queue is visible rather than missing", () => {
    const usage = summarizeUsageByProfile(["p1", "p2"], [
      { printer_profile_id: "p1", created_at: minutesAgo(10), status: "completed" },
    ]);
    expect(usage.p1?.totalJobs).toBe(1);
    expect(usage.p2).toEqual({ totalJobs: 0, printedJobs: 0, lastUsedAt: null });
  });

  it("ignores jobs belonging to a profile this Agent doesn't own, and jobs with no profile", () => {
    const usage = summarizeUsageByProfile(["p1"], [
      { printer_profile_id: "p1", created_at: minutesAgo(10), status: "completed" },
      { printer_profile_id: "someone-elses", created_at: minutesAgo(1), status: "completed" },
      { printer_profile_id: null, created_at: minutesAgo(1), status: "completed" },
    ]);
    expect(Object.keys(usage)).toEqual(["p1"]);
    expect(usage.p1?.totalJobs).toBe(1);
  });
});

describe("deriveAgentActivity", () => {
  it("keeps 'last synced' and 'last actual work' as separate answers - a healthy but idle Agent is the whole point", () => {
    const activity = deriveAgentActivity(
      minutesAgo(0),
      [{ updated_at: minutesAgo(4320) }], // three days ago
      [{ completed_at: minutesAgo(120) }],
    );
    expect(activity.lastSyncedAt).toBe(minutesAgo(0));
    expect(activity.lastJobActivityAt).toBe(minutesAgo(4320));
    expect(activity.lastCommandAt).toBe(minutesAgo(120));
  });

  it("returns null - never a fabricated timestamp - for a signal that genuinely does not exist yet", () => {
    expect(deriveAgentActivity(null, [], [])).toEqual({
      lastSyncedAt: null,
      lastJobActivityAt: null,
      lastCommandAt: null,
    });
  });

  it("ignores commands that were issued but never answered when reporting the last command carried out", () => {
    const activity = deriveAgentActivity(minutesAgo(1), [], [{ completed_at: null }, { completed_at: minutesAgo(50) }]);
    expect(activity.lastCommandAt).toBe(minutesAgo(50));
  });

  it("takes the newest of several leased jobs", () => {
    const activity = deriveAgentActivity(
      minutesAgo(1),
      [{ updated_at: minutesAgo(500) }, { updated_at: minutesAgo(9) }, { updated_at: minutesAgo(80) }],
      [],
    );
    expect(activity.lastJobActivityAt).toBe(minutesAgo(9));
  });
});

describe("compareAgentVersions / describeAgentVersion", () => {
  it("compares numerically, not lexicographically (0.10.0 is newer than 0.9.0)", () => {
    expect(compareAgentVersions("0.10.0", "0.9.0")).toBe("ahead");
    expect(compareAgentVersions("0.9.0", "0.10.0")).toBe("outdated");
    expect(compareAgentVersions("1.2.3", "1.2.3")).toBe("up_to_date");
  });

  it("treats a missing/blank reported version as unknown rather than guessing", () => {
    expect(compareAgentVersions(null, "0.1.0")).toBe("unknown");
    expect(compareAgentVersions("   ", "0.1.0")).toBe("unknown");
  });

  it("handles version strings of differing segment counts", () => {
    expect(compareAgentVersions("1.2", "1.2.0")).toBe("up_to_date");
    expect(compareAgentVersions("1.2", "1.2.1")).toBe("outdated");
  });

  it("says what to do, in plain language, for each state", () => {
    expect(describeAgentVersion("0.1.0", "0.2.0").state).toBe("outdated");
    expect(describeAgentVersion("0.1.0", "0.2.0").summary).toContain("0.2.0 is available");
    expect(describeAgentVersion(null, "0.2.0").summary).toMatch(/hasn't reported a version/);
    expect(describeAgentVersion("0.2.0", "0.2.0").summary).toMatch(/up to date/);
    expect(describeAgentVersion("0.3.0", "0.2.0").state).toBe("ahead");
  });
});

describe("isAgentOnline", () => {
  it("uses the same 5-minute staleness rule as the rest of /admin", () => {
    expect(AGENT_ONLINE_WINDOW_MS).toBe(5 * 60_000);
    expect(isAgentOnline(minutesAgo(1), NOW)).toBe(true);
    expect(isAgentOnline(minutesAgo(6), NOW)).toBe(false);
    expect(isAgentOnline(null, NOW)).toBe(false);
  });
});

describe("describeAgentConnection", () => {
  it("shows a paused Agent as paused, NOT as offline - a deliberately held machine is not a broken one", () => {
    const state = describeAgentConnection(
      { status: "active", paused: true, last_seen_at: minutesAgo(1) },
      NOW,
    );
    expect(state.label).toBe("Paused");
    expect(state.tone).toBe("warning");
    expect(state.detail).toMatch(/will not take new print jobs/);
  });

  it("distinguishes a paused-and-also-unreachable machine from a paused, healthy one", () => {
    const stale = describeAgentConnection({ status: "active", paused: true, last_seen_at: minutesAgo(60) }, NOW);
    expect(stale.label).toBe("Paused");
    expect(stale.detail).toMatch(/hasn't checked in/);
  });

  it("reports a revoked credential as disabled, ahead of any online/paused consideration", () => {
    const state = describeAgentConnection({ status: "disabled", paused: true, last_seen_at: minutesAgo(1) }, NOW);
    expect(state.label).toBe("Disabled");
    expect(state.tone).toBe("danger");
  });

  it("distinguishes 'never connected since it was registered' from 'stopped answering'", () => {
    expect(describeAgentConnection({ status: "pending", paused: false, last_seen_at: null }, NOW).label).toBe(
      "Awaiting setup",
    );
    const neverSeen = describeAgentConnection({ status: "active", paused: false, last_seen_at: null }, NOW);
    expect(neverSeen.label).toBe("Offline");
    expect(neverSeen.detail).toMatch(/never checked in/);
  });

  it("is online only for an active, unpaused, recently-heard-from Agent", () => {
    const state = describeAgentConnection({ status: "active", paused: false, last_seen_at: minutesAgo(1) }, NOW);
    expect(state.label).toBe("Online");
    expect(state.tone).toBe("success");
  });
});
