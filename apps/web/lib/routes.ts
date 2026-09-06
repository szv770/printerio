/**
 * Centralized internal route paths. Nothing in app/** should hardcode an
 * href/redirect string for one of these routes - import from here instead,
 * so renaming or restructuring a route is a one-line change, not a grep
 * across every Link/redirect/revalidatePath call.
 *
 * Keep this in sync with the actual app/ directory structure by hand - Next.js
 * has no built-in typed-route export we can generate this from yet.
 */
export const routes = {
  home: "/",
  login: "/login",
  authCallback: "/auth/callback",
  noAccess: "/no-access",

  dashboard: "/home",
  print: "/print",
  jobs: "/jobs",
  job: (jobId: string) => `/jobs/${jobId}`,
  profile: "/profile",
  usage: "/usage",

  admin: "/admin",
  adminApprovals: "/admin/approvals",
  adminUsers: "/admin/users",
  adminGroups: "/admin/groups",
  adminQuotas: "/admin/quotas",
  adminSettings: "/admin/settings",
  adminPolicies: "/admin/policies",
  adminPrinters: "/admin/printers",
  adminAgents: "/admin/agents",
  adminAudit: "/admin/audit",
  adminReports: "/admin/reports",
} as const;

/** API routes the Agent and the admin dashboard call - kept alongside the
 *  page routes for the same reason. See docs/agent-api.md for the full
 *  request/response contract of the agents.* group. */
export const apiRoutes = {
  agentsRegister: "/api/agents/register",
  agentsHeartbeat: "/api/agents/heartbeat",
  agentsJobsClaimable: "/api/agents/jobs/claimable",
  agentJobClaim: (jobId: string) => `/api/agents/jobs/${jobId}/claim`,
  agentJobDownloadUrl: (jobId: string) => `/api/agents/jobs/${jobId}/download-url`,
  agentJobStatus: (jobId: string) => `/api/agents/jobs/${jobId}/status`,
  agentsCommands: "/api/agents/commands",
  agentCommandAck: (commandId: string) => `/api/agents/commands/${commandId}/ack`,
  adminCommands: "/api/admin/commands",
  cronSweep: "/api/cron/sweep",
} as const;
