import { describe, it, expect } from "vitest";
import { isAgentOnline, buildOrganizationSummaries, summarizeDeploymentTotals, AGENT_ONLINE_CUTOFF_MS } from "./overview";

describe("isAgentOnline", () => {
  const now = new Date("2026-01-01T00:10:00.000Z").getTime();

  it("is offline when last_seen_at is null", () => {
    expect(isAgentOnline(null, now)).toBe(false);
  });

  it("is online within the cutoff", () => {
    const lastSeen = new Date(now - AGENT_ONLINE_CUTOFF_MS + 1000).toISOString();
    expect(isAgentOnline(lastSeen, now)).toBe(true);
  });

  it("is offline right at and beyond the cutoff", () => {
    const atCutoff = new Date(now - AGENT_ONLINE_CUTOFF_MS).toISOString();
    expect(isAgentOnline(atCutoff, now)).toBe(true); // <= cutoff is still online
    const beyondCutoff = new Date(now - AGENT_ONLINE_CUTOFF_MS - 1).toISOString();
    expect(isAgentOnline(beyondCutoff, now)).toBe(false);
  });
});

describe("buildOrganizationSummaries", () => {
  const nowMs = new Date("2026-01-01T00:00:00.000Z").getTime();
  const orgs = [
    { id: "org-a", name: "Org A", slug: "org-a" },
    { id: "org-b", name: "Org B", slug: "org-b" },
  ];

  it("counts each row type per organization independently", () => {
    const summaries = buildOrganizationSummaries({
      organizations: orgs,
      members: [{ organization_id: "org-a" }, { organization_id: "org-a" }, { organization_id: "org-b" }],
      printers: [{ organization_id: "org-a" }],
      agents: [
        { organization_id: "org-a", last_seen_at: new Date(nowMs).toISOString() }, // online
        { organization_id: "org-a", last_seen_at: null }, // offline
        { organization_id: "org-b", last_seen_at: new Date(nowMs - 60 * 60_000).toISOString() }, // offline (1h stale)
      ],
      jobsLast30d: [{ organization_id: "org-a" }, { organization_id: "org-b" }, { organization_id: "org-b" }],
      nowMs,
    });

    expect(summaries).toEqual([
      {
        id: "org-a",
        name: "Org A",
        slug: "org-a",
        memberCount: 2,
        printerCount: 1,
        agentCount: 2,
        agentsOnline: 1,
        jobsLast30d: 1,
      },
      {
        id: "org-b",
        name: "Org B",
        slug: "org-b",
        memberCount: 1,
        printerCount: 0,
        agentCount: 1,
        agentsOnline: 0,
        jobsLast30d: 2,
      },
    ]);
  });

  it("returns zeroed counts for an organization with no related rows", () => {
    const summaries = buildOrganizationSummaries({
      organizations: [{ id: "org-c", name: "Org C", slug: "org-c" }],
      members: [],
      printers: [],
      agents: [],
      jobsLast30d: [],
      nowMs,
    });
    expect(summaries).toEqual([
      {
        id: "org-c",
        name: "Org C",
        slug: "org-c",
        memberCount: 0,
        printerCount: 0,
        agentCount: 0,
        agentsOnline: 0,
        jobsLast30d: 0,
      },
    ]);
  });
});

describe("summarizeDeploymentTotals", () => {
  it("sums every field across organizations", () => {
    const totals = summarizeDeploymentTotals([
      { id: "a", name: "A", slug: "a", memberCount: 2, printerCount: 1, agentCount: 2, agentsOnline: 1, jobsLast30d: 5 },
      { id: "b", name: "B", slug: "b", memberCount: 3, printerCount: 0, agentCount: 1, agentsOnline: 0, jobsLast30d: 2 },
    ]);
    expect(totals).toEqual({ organizations: 2, members: 5, printers: 1, agents: 3, agentsOnline: 1, jobsLast30d: 7 });
  });

  it("returns all zeros for an empty deployment", () => {
    expect(summarizeDeploymentTotals([])).toEqual({
      organizations: 0,
      members: 0,
      printers: 0,
      agents: 0,
      agentsOnline: 0,
      jobsLast30d: 0,
    });
  });
});
