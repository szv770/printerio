import { routes } from "./routes";

/**
 * Pure navigation model for the one app shell. The shell is chosen by the
 * signed-in user's ROLE, never by the URL: an org admin or approver sees the
 * admin menu on /print, /jobs, /devices etc. exactly as on /admin/users, and a
 * plain member keeps the simple member header. Kept free of React so it is unit
 * tested (there is no component test setup); components/shell maps `icon` keys
 * to lucide icons.
 */

export type ShellKind = "admin" | "member";

/** Roles with an admin menu. Anything else (staff, student, unknown) is a member. */
export function resolveShell(role: string | null | undefined): ShellKind {
  return role === "org_admin" || role === "approver" ? "admin" : "member";
}

/** `data-tour` anchors owned by the shell (see lib/onboarding-content.ts). */
export const TOUR_ANCHORS = { myJobs: "nav-my-jobs" } as const;

export type NavIcon =
  | "overview"
  | "approvals"
  | "users"
  | "groups"
  | "printers"
  | "agents"
  | "devices"
  | "policies"
  | "quotas"
  | "reports"
  | "audit"
  | "storage"
  | "settings"
  | "print"
  | "jobs"
  | "usage"
  | "profile";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Only an exact pathname match is active (/admin is a prefix of every admin page). */
  exact?: boolean;
  tourAnchor?: string;
  /** Show the pending-approvals count next to the label. */
  badge?: "pendingApprovals";
}

export interface NavGroup {
  /** null = untitled block at the top of the menu. */
  title: string | null;
  items: NavItem[];
}

const MY_JOBS: NavItem = { href: routes.jobs, label: "My jobs", icon: "jobs", tourAnchor: TOUR_ANCHORS.myJobs };

/** The prominent "+ Print a document" entry (a button, not a list row). */
export const PRINT_ITEM: NavItem = { href: routes.print, label: "Print a document", icon: "print" };

/** Menu for org admins (isOrgAdmin) and approvers. Print is the header button. */
export function adminMenu(isOrgAdmin: boolean): NavGroup[] {
  return [
    {
      title: null,
      items: [
        MY_JOBS,
        { href: routes.usage, label: "Usage", icon: "usage" },
        { href: routes.devices, label: "My devices", icon: "devices" },
        { href: routes.profile, label: "Profile", icon: "profile" },
      ],
    },
    { title: "Admin", items: [{ href: routes.admin, label: "Overview", icon: "overview", exact: true }] },
    {
      title: "People",
      items: [
        { href: routes.adminUsers, label: "Users", icon: "users" },
        { href: routes.adminGroups, label: "Groups", icon: "groups" },
      ],
    },
    {
      title: "Printers",
      items: [
        { href: routes.adminPrinters, label: "Printers", icon: "printers" },
        { href: routes.adminAgents, label: "Agents", icon: "agents" },
        // Devices / Audit log / Storage require org_admin on their own pages.
        ...(isOrgAdmin ? [{ href: routes.adminDevices, label: "Devices", icon: "devices" as const }] : []),
      ],
    },
    {
      title: "Rules",
      items: [
        { href: routes.adminApprovals, label: "Approvals", icon: "approvals", badge: "pendingApprovals" },
        { href: routes.adminPolicies, label: "Policies", icon: "policies" },
        { href: routes.adminQuotas, label: "Quotas", icon: "quotas" },
      ],
    },
    {
      title: "Reports & settings",
      items: [
        { href: routes.adminReports, label: "Reports", icon: "reports" },
        ...(isOrgAdmin
          ? [
              { href: routes.adminAudit, label: "Audit log", icon: "audit" as const },
              { href: routes.adminStorage, label: "Storage", icon: "storage" as const },
            ]
          : []),
        { href: routes.adminSettings, label: "Settings", icon: "settings" },
      ],
    },
  ];
}

/** The simple member header, in order. */
export function memberMenu(): NavItem[] {
  return [
    { href: routes.print, label: "Print", icon: "print" },
    MY_JOBS,
    { href: routes.usage, label: "Usage", icon: "usage" },
    { href: routes.devices, label: "My devices", icon: "devices" },
    { href: routes.profile, label: "Profile", icon: "profile" },
  ];
}

export function isActiveHref(href: string, pathname: string, exact = false): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return exact ? path === href : path === href || path.startsWith(`${href}/`);
}

/** The single menu href that should show as current for this pathname (incl. the Print button). */
export function activeItemHref(groups: NavGroup[], pathname: string): string | null {
  const items = [PRINT_ITEM, ...groups.flatMap((g) => g.items)];
  let best: NavItem | null = null;
  for (const item of items) {
    if (!isActiveHref(item.href, pathname, item.exact)) continue;
    // Longest matching href wins, so /admin/printers beats a shorter prefix.
    if (!best || item.href.length > best.href.length) best = item;
  }
  return best ? best.href : null;
}
