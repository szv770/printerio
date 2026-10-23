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
  /** Other pages that belong to this item (shown as tabs on it), so it stays current there. */
  also?: string[];
  tourAnchor?: string;
  /** Show the pending-approvals count next to the label. */
  badge?: "pendingApprovals";
}

export interface NavGroup {
  /** Stable key (state, DOM ids). */
  id: string;
  /** null = untitled block at the top of the menu. */
  title: string | null;
  /** Always-visible groups cannot be folded away (the ones holding daily actions and tour anchors). */
  alwaysOpen?: boolean;
  items: NavItem[];
}

const MY_JOBS: NavItem = { href: routes.jobs, label: "My jobs", icon: "jobs", tourAnchor: TOUR_ANCHORS.myJobs };

/** The prominent "+ Print a document" entry (a button, not a list row). */
export const PRINT_ITEM: NavItem = { href: routes.print, label: "Print a document", icon: "print" };

/**
 * Menu for org admins (isOrgAdmin) and approvers. Print is the header button.
 * Overview, My jobs and Approvals are always visible (daily use + the My jobs
 * tour anchor must exist while folded); the other groups fold, and the one
 * holding the current page opens itself (see openGroupIds).
 */
export function adminMenu(isOrgAdmin: boolean): NavGroup[] {
  return [
    {
      id: "main",
      title: null,
      alwaysOpen: true,
      items: [
        { href: routes.admin, label: "Overview", icon: "overview", exact: true },
        MY_JOBS,
        { href: routes.adminApprovals, label: "Approvals", icon: "approvals", badge: "pendingApprovals" },
      ],
    },
    {
      id: "people",
      title: "People",
      items: [
        { href: routes.adminUsers, label: "Users", icon: "users", also: [routes.adminInvites] },
        { href: routes.adminGroups, label: "Groups", icon: "groups" },
      ],
    },
    {
      id: "printers",
      title: "Printers & devices",
      items: [
        { href: routes.adminPrinters, label: "Printers", icon: "printers" },
        { href: routes.adminAgents, label: "Print servers", icon: "agents" },
        // Devices / Audit log / Storage require org_admin on their own pages.
        ...(isOrgAdmin ? [{ href: routes.adminDevices, label: "User devices", icon: "devices" as const }] : []),
      ],
    },
    {
      id: "rules",
      title: "Rules & limits",
      items: [
        { href: routes.adminPolicies, label: "Print rules", icon: "policies" },
        { href: routes.adminQuotas, label: "Monthly limits", icon: "quotas" },
      ],
    },
    {
      id: "reports",
      title: "Reports",
      items: [
        { href: routes.adminReports, label: "Usage reports", icon: "reports" },
        ...(isOrgAdmin ? [{ href: routes.adminAudit, label: "Audit log", icon: "audit" as const }] : []),
      ],
    },
    {
      id: "settings",
      title: "Settings",
      items: [
        { href: routes.adminSettings, label: "General", icon: "settings" },
        ...(isOrgAdmin ? [{ href: routes.adminStorage, label: "Files & storage", icon: "storage" as const }] : []),
      ],
    },
    {
      id: "account",
      title: "My account",
      items: [
        { href: routes.usage, label: "My usage", icon: "usage" },
        { href: routes.devices, label: "My devices", icon: "devices" },
        { href: routes.profile, label: "Profile", icon: "profile" },
      ],
    },
  ];
}

/** Ids of the groups that should render open: always-open ones plus the one holding the current page. */
export function openGroupIds(groups: NavGroup[], pathname: string): string[] {
  const active = activeItemHref(groups, pathname);
  return groups
    .filter((g) => g.alwaysOpen || g.title === null || (active !== null && g.items.some((i) => i.href === active)))
    .map((g) => g.id);
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
    if (!isActiveHref(item.href, pathname, item.exact) && !item.also?.some((h) => isActiveHref(h, pathname))) continue;
    // Longest matching href wins, so /admin/printers beats a shorter prefix.
    if (!best || item.href.length > best.href.length) best = item;
  }
  return best ? best.href : null;
}

/** Friendly role name for the user chip. */
export function roleLabel(role: string | null | undefined): string {
  switch (role) {
    case "org_admin":
      return "Admin";
    case "approver":
      return "Approver";
    case "staff":
      return "Staff";
    case "student":
      return "Student";
    default:
      return "Member";
  }
}

/** One uppercase letter for the avatar: first letter of the name, else the email, else "?". */
export function avatarInitial(name: string | null | undefined, email?: string | null): string {
  const src = (name ?? "").trim() || (email ?? "").trim();
  return src ? src.charAt(0).toUpperCase() : "?";
}
