"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard,
  CheckSquare,
  Users,
  FolderKanban,
  Printer,
  Cpu,
  Smartphone,
  ShieldCheck,
  Gauge,
  Globe,
  HardDrive,
  BarChart3,
  ScrollText,
  Plus,
  ListChecks,
  PieChart,
  UserRound,
  Menu,
  X,
  type LucideIcon,
} from "lucide-react";
import { signOutAction } from "@/lib/auth/actions";
import { routes } from "@/lib/routes";
import { Badge } from "@/components/ui";
import { HelpMenu } from "@/components/help/HelpMenu";
import {
  PRINT_ITEM,
  activeItemHref,
  adminMenu,
  type NavGroup as NavGroupModel,
  type NavIcon,
  type NavItem,
} from "@/lib/nav";

/**
 * The admin shell's navigation, in both of the shapes it needs to exist in.
 * It now wraps EVERY page an admin or approver visits, including the member
 * pages (/print, /jobs, /devices, /profile, /usage): the menu is chosen by
 * role in AppShell, not by URL, so an admin is never thrown out of it. The
 * menu content and active-item logic live in lib/nav.ts (unit tested).
 *
 * Why this is a client component: the sidebar used to be an unconditional
 * `w-48` column with no mobile treatment, leaving ~119px for the page body on
 * a 375px phone. A drawer needs open/close state, so the nav (and only the
 * nav) is a client component; the layouts stay server components.
 *
 * Two renderings of one item list, never two lists to keep in sync:
 *   - `md:hidden` sticky top bar + slide-over drawer on small screens.
 *   - `hidden md:block` sticky sidebar from 768px up.
 *
 * The drawer's open state is stored as *which path it was opened on*, so
 * "open" is derived rather than synchronized: any navigation changes the
 * pathname and the drawer is closed by construction.
 */
export function AdminNav({
  isOrgAdmin,
  isSuperAdmin,
  userId,
  pendingApprovals,
}: {
  isOrgAdmin: boolean;
  isSuperAdmin: boolean;
  userId: string;
  pendingApprovals: number;
}) {
  const pathname = usePathname();
  const [openedOnPath, setOpenedOnPath] = useState<string | null>(null);
  const open = openedOnPath === pathname;
  const openDrawer = () => setOpenedOnPath(pathname);
  const closeDrawer = () => setOpenedOnPath(null);

  return (
    <>
      {/* Small screens: a sticky bar that is the only thing the nav costs
       *  vertically until it's asked for. `-mx-4 px-4` bleeds it to the
       *  viewport edges through the layout's own horizontal padding. */}
      <div className="sticky top-0 z-30 -mx-4 flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 md:hidden">
        <button
          type="button"
          onClick={openDrawer}
          aria-label="Open the menu"
          aria-expanded={open}
          className="-ml-2 shrink-0 rounded-lg p-2 text-[var(--color-text)] hover:bg-[var(--color-surface)]"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Link href={routes.admin} className="min-w-0 flex-1 truncate text-base font-semibold">
          Printio Admin
        </Link>
        {pendingApprovals > 0 && (
          <Link href={routes.adminApprovals} className="shrink-0">
            <Badge tone="warning">{pendingApprovals} to approve</Badge>
          </Link>
        )}
        <Link
          href={PRINT_ITEM.href}
          className="flex shrink-0 items-center gap-1 rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-sm font-semibold text-[var(--color-primary-fg)] hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Print
        </Link>
      </div>

      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          {/* A real <button> rather than a div, so the scrim is dismissible by
           *  keyboard and announced, not just tappable. */}
          <button
            type="button"
            aria-label="Close the menu"
            onClick={closeDrawer}
            className="absolute inset-0 bg-black/40"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            className="absolute inset-y-0 left-0 w-72 max-w-[85%] overflow-y-auto bg-[var(--color-bg)] p-4 shadow-xl"
          >
            <div className="mb-4 flex items-center justify-between gap-2">
              <Link href={routes.admin} className="text-lg font-semibold">
                Printio Admin
              </Link>
              <button
                type="button"
                onClick={closeDrawer}
                aria-label="Close the menu"
                className="rounded-lg p-2 hover:bg-[var(--color-surface)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <NavItems
              isOrgAdmin={isOrgAdmin}
              isSuperAdmin={isSuperAdmin}
              userId={userId}
              pendingApprovals={pendingApprovals}
              pathname={pathname}
              mountHelp
            />
          </div>
        </div>
      )}

      <nav
        aria-label="Main menu"
        className="hidden w-52 shrink-0 md:sticky md:top-8 md:block md:max-h-[calc(100vh-4rem)] md:self-start md:overflow-y-auto"
      >
        <Link href={routes.admin} className="mb-4 block px-1 text-lg font-semibold">
          Printio Admin
        </Link>
        <NavItems
          isOrgAdmin={isOrgAdmin}
          isSuperAdmin={isSuperAdmin}
          userId={userId}
          pendingApprovals={pendingApprovals}
          pathname={pathname}
          mountHelp={!open}
        />
      </nav>
    </>
  );
}

const ICONS: Record<NavIcon, LucideIcon> = {
  overview: LayoutDashboard,
  approvals: CheckSquare,
  users: Users,
  groups: FolderKanban,
  printers: Printer,
  agents: Cpu,
  devices: Smartphone,
  policies: ShieldCheck,
  quotas: Gauge,
  reports: BarChart3,
  audit: ScrollText,
  storage: HardDrive,
  settings: Globe,
  print: Plus,
  jobs: ListChecks,
  usage: PieChart,
  profile: UserRound,
};

function NavItems({
  isOrgAdmin,
  isSuperAdmin,
  userId,
  pendingApprovals,
  pathname,
  mountHelp,
}: {
  isOrgAdmin: boolean;
  isSuperAdmin: boolean;
  userId: string;
  pendingApprovals: number;
  pathname: string;
  /**
   * Whether this rendering owns the (single) HelpMenu instance and the
   * `data-tour` anchors.
   *
   * The sidebar is `hidden md:block` - hidden, but still mounted - so while
   * the drawer is open both renderings exist in the DOM at once. HelpMenu is
   * stateful (it auto-opens the first-login tour and carries the
   * `data-tour="help-button"` spotlight anchor), so a second copy would open a
   * second tour over the first and give document.querySelector two anchors to
   * pick from. The same goes for `nav-my-jobs`. The drawer takes ownership
   * while it's open, the sidebar the rest of the time - on desktop the drawer
   * can never open at all (its trigger is `md:hidden`), so nothing there
   * changes.
   */
  mountHelp: boolean;
}) {
  const groups = adminMenu(isOrgAdmin);
  const activeHref = activeItemHref(groups, pathname);
  const printActive = activeHref === PRINT_ITEM.href;
  return (
    <>
      {/* The primary action, always one tap away, on every page. */}
      <Link
        href={PRINT_ITEM.href}
        aria-current={printActive ? "page" : undefined}
        className={`flex items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-3 py-2.5 text-sm font-semibold text-[var(--color-primary-fg)] shadow-sm hover:opacity-90 ${
          printActive ? "ring-2 ring-[var(--color-primary)] ring-offset-2" : ""
        }`}
      >
        <Plus className="h-4 w-4" />
        Print a document
      </Link>

      {groups.map((group, i) => (
        <NavGroup key={group.title ?? `top-${i}`} group={group}>
          {group.items.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={item.href === activeHref}
              pendingApprovals={pendingApprovals}
              mountAnchors={mountHelp}
            />
          ))}
        </NavGroup>
      ))}

      <div className="mt-6 flex flex-col gap-1 border-t border-[var(--color-border)] pt-4 text-sm">
        {isSuperAdmin && (
          <Link href={routes.platform} className="block rounded-lg px-3 py-2 hover:bg-[var(--color-surface)]">
            Platform console
          </Link>
        )}
        {/* Exactly one HelpMenu is ever mounted (see mountHelp's own note). */}
        {mountHelp && (
          <div className="px-3 py-2">
            <HelpMenu userId={userId} variant="admin" />
          </div>
        )}
        <form action={signOutAction}>
          <button
            type="submit"
            className="block w-full rounded-lg px-3 py-2 text-left text-[var(--color-muted)] hover:bg-[var(--color-surface)]"
          >
            Sign out
          </button>
        </form>
      </div>
    </>
  );
}

function NavGroup({ group, children }: { group: NavGroupModel; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-[var(--color-border)] pt-4">
      {group.title && (
        <p className="mb-1 px-3 text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">{group.title}</p>
      )}
      <ul className="flex flex-col gap-1 text-sm">{children}</ul>
    </div>
  );
}

function NavLink({
  item,
  active,
  pendingApprovals,
  mountAnchors,
}: {
  item: NavItem;
  active: boolean;
  pendingApprovals: number;
  mountAnchors: boolean;
}) {
  const Icon = ICONS[item.icon];
  return (
    <li>
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        data-tour={mountAnchors ? item.tourAnchor : undefined}
        className={`flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-[var(--color-surface)] ${
          active ? "bg-[var(--color-surface)] font-medium text-[var(--color-primary)]" : ""
        }`}
      >
        <Icon className={`h-4 w-4 shrink-0 ${active ? "text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`} />
        <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
          {item.label}
          {item.badge === "pendingApprovals" && pendingApprovals > 0 && (
            <Badge tone="warning">{pendingApprovals}</Badge>
          )}
        </span>
      </Link>
    </li>
  );
}
