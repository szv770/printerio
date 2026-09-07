import { describe, it, expect } from "vitest";
import {
  setupChecklist,
  isSetupComplete,
  setupProgress,
  nextSetupStep,
  type SetupCounts,
  type SetupRoutes,
} from "./admin-setup-checklist";

const ROUTES: SetupRoutes = {
  agents: "/admin/agents",
  printersSetup: "/admin/printers/setup",
  users: "/admin/users",
  policies: "/admin/policies",
};

const EMPTY_ORG: SetupCounts = {
  agents: 0,
  onlineAgents: 0,
  printers: 0,
  printerProfiles: 0,
  members: 1, // the bootstrap admin themselves
  policies: 0,
  quotas: 0,
};

const READY_ORG: SetupCounts = {
  agents: 1,
  onlineAgents: 1,
  printers: 1,
  printerProfiles: 2,
  members: 40,
  policies: 1,
  quotas: 0,
};

describe("setupChecklist", () => {
  it("marks nothing done for a freshly bootstrapped organization", () => {
    const steps = setupChecklist(EMPTY_ORG, ROUTES);
    expect(steps.every((s) => !s.done)).toBe(true);
  });

  it("does not count the bootstrap admin alone as having invited anyone", () => {
    const steps = setupChecklist(EMPTY_ORG, ROUTES);
    expect(steps.find((s) => s.id === "invite_users")?.done).toBe(false);
    const withOneOther = setupChecklist({ ...EMPTY_ORG, members: 2 }, ROUTES);
    expect(withOneOther.find((s) => s.id === "invite_users")?.done).toBe(true);
  });

  it("treats a registered-but-never-seen Agent as registered, not online", () => {
    const steps = setupChecklist({ ...EMPTY_ORG, agents: 1, onlineAgents: 0 }, ROUTES);
    expect(steps.find((s) => s.id === "register_agent")?.done).toBe(true);
    expect(steps.find((s) => s.id === "agent_online")?.done).toBe(false);
  });

  it("requires a profile, not just a printer row, for the printer step", () => {
    // A printers row with no printer_profiles has no Windows queue behind it,
    // so no job can actually be routed to it.
    const printerOnly = setupChecklist({ ...EMPTY_ORG, printers: 1, printerProfiles: 0 }, ROUTES);
    expect(printerOnly.find((s) => s.id === "printer_profiles")?.done).toBe(false);
    const withProfile = setupChecklist({ ...EMPTY_ORG, printers: 1, printerProfiles: 1 }, ROUTES);
    expect(withProfile.find((s) => s.id === "printer_profiles")?.done).toBe(true);
  });

  it("accepts either a policy or a quota as the governance step", () => {
    const policyOnly = setupChecklist({ ...EMPTY_ORG, policies: 1 }, ROUTES);
    expect(policyOnly.find((s) => s.id === "rules")?.done).toBe(true);
    const quotaOnly = setupChecklist({ ...EMPTY_ORG, quotas: 1 }, ROUTES);
    expect(quotaOnly.find((s) => s.id === "rules")?.done).toBe(true);
  });

  it("points every step at a real admin route", () => {
    const hrefs = Object.values(ROUTES);
    for (const step of setupChecklist(EMPTY_ORG, ROUTES)) {
      expect(hrefs).toContain(step.href);
    }
  });
});

describe("isSetupComplete", () => {
  it("is false while any required step is outstanding", () => {
    expect(isSetupComplete(setupChecklist(EMPTY_ORG, ROUTES))).toBe(false);
  });

  it("is true once every required step is done, even with an optional one left", () => {
    const steps = setupChecklist({ ...READY_ORG, policies: 0, quotas: 0 }, ROUTES);
    expect(steps.find((s) => s.id === "rules")?.done).toBe(false);
    expect(isSetupComplete(steps)).toBe(true);
  });
});

describe("setupProgress", () => {
  it("counts every step, optional ones included", () => {
    expect(setupProgress(setupChecklist(EMPTY_ORG, ROUTES))).toEqual({ done: 0, total: 5 });
    expect(setupProgress(setupChecklist(READY_ORG, ROUTES))).toEqual({ done: 5, total: 5 });
  });
});

describe("nextSetupStep", () => {
  it("returns the first outstanding required step", () => {
    expect(nextSetupStep(setupChecklist(EMPTY_ORG, ROUTES))?.id).toBe("register_agent");
    const agentDone = setupChecklist({ ...EMPTY_ORG, agents: 1 }, ROUTES);
    expect(nextSetupStep(agentDone)?.id).toBe("agent_online");
  });

  it("falls back to an optional step only when nothing required is left", () => {
    const steps = setupChecklist({ ...READY_ORG, policies: 0, quotas: 0 }, ROUTES);
    expect(nextSetupStep(steps)?.id).toBe("rules");
  });

  it("returns null when everything is done", () => {
    expect(nextSetupStep(setupChecklist(READY_ORG, ROUTES))).toBeNull();
  });
});
