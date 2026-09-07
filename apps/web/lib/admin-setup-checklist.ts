/**
 * "What do I still have to do before this system actually prints anything?" -
 * the ordered setup checklist shown on Admin -> Overview until it's finished.
 *
 * Admin -> Overview is deliberately problem-first (see app/admin/page.tsx):
 * it shows pending approvals, offline agents, printers in error. On a
 * brand-new organization every one of those counters is legitimately zero, so
 * the very first thing a new administrator saw was a grid of five zeroes and
 * no indication of what to do next - the healthiest-looking possible rendering
 * of a completely unusable system. This turns that same emptiness into the
 * ordered list of steps that actually gets a job onto paper.
 *
 * Pure data: no queries, no JSX, so the ordering/completion rules are
 * unit-testable and the page just renders whatever comes back.
 */

export interface SetupCounts {
  agents: number;
  /** Agents that have heartbeated recently enough to count as online. */
  onlineAgents: number;
  printers: number;
  /** printer_profiles rows - the actual Windows-queue mappings a job needs. */
  printerProfiles: number;
  /** organization_members rows, including the admin reading this. */
  members: number;
  policies: number;
  quotas: number;
}

export interface SetupStep {
  id: string;
  title: string;
  /** One sentence on what to do, written for someone who has not read the docs. */
  description: string;
  /** Route key from lib/routes.ts - the page that step is done on. */
  href: string;
  done: boolean;
  /** Recommended rather than required: the system prints without it. */
  optional?: boolean;
}

/**
 * `routes` values are passed in rather than imported so this module stays
 * dependency-free and testable; app/admin/page.tsx supplies them.
 */
export interface SetupRoutes {
  agents: string;
  printersSetup: string;
  users: string;
  policies: string;
}

export function setupChecklist(counts: SetupCounts, routes: SetupRoutes): SetupStep[] {
  return [
    {
      id: "register_agent",
      title: "Register the Windows Print Agent",
      description:
        "Create an agent record here to get a 24-hour enrollment code, then run the Agent's register command with that code on the Windows machine next to the printer (docs/agent-install.md).",
      href: routes.agents,
      done: counts.agents > 0,
    },
    {
      id: "agent_online",
      title: "Wait for that Agent to check in",
      description:
        "Once it's running, the Agent heartbeats every few minutes and shows as online. Until it does, nothing can reach a printer - no job will ever leave 'approved'.",
      href: routes.agents,
      done: counts.onlineAgents > 0,
    },
    {
      id: "printer_profiles",
      title: "Add a printer and its finishing profiles",
      description:
        "The guided setup wizard reads the print queues the Agent actually found on that machine, so you pick from a list instead of typing a Windows queue name by hand.",
      href: routes.printersSetup,
      done: counts.printers > 0 && counts.printerProfiles > 0,
    },
    {
      id: "invite_users",
      title: "Invite the people who will be printing",
      description:
        "Generate an enrollment code and share it. Everyone after you joins with a code - there is no self-signup, by design.",
      href: routes.users,
      done: counts.members > 1,
    },
    {
      id: "rules",
      title: "Decide what needs approval, and set print limits",
      description:
        "Without a policy every job falls through to your organization's default action, and without a quota nobody has a monthly limit. Both are safe to leave for later.",
      href: routes.policies,
      done: counts.policies > 0 || counts.quotas > 0,
      optional: true,
    },
  ];
}

/** True once every required (non-optional) step is done - the point at which
 *  the checklist stops being shown at all. */
export function isSetupComplete(steps: SetupStep[]): boolean {
  return steps.every((step) => step.done || step.optional);
}

/** "2 of 5" progress, counting every step including the optional ones so the
 *  number matches what the reader can see on screen. */
export function setupProgress(steps: SetupStep[]): { done: number; total: number } {
  return { done: steps.filter((s) => s.done).length, total: steps.length };
}

/** The first thing still worth doing - required steps first, in order, then
 *  any optional leftovers. Used to point the admin at one next action rather
 *  than a wall of five. */
export function nextSetupStep(steps: SetupStep[]): SetupStep | null {
  return steps.find((s) => !s.done && !s.optional) ?? steps.find((s) => !s.done) ?? null;
}
