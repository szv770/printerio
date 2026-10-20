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
  ShieldCheck,
  Gauge,
  Globe,
  HardDrive,
  BarChart3,
  ScrollText,
  FilePlus,
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

/**
 * The admin console's navigation, in both of the shapes it needs to exist in.
 *
 * Why this is a client component and not part of admin/layout.tsx any more:
 * the sidebar used to be an unconditional `w-48` column inside a
 * `flex gap-8 px-4` row, with no mobile treatment at all. On a 375px-wide
 * phone that leaves 375 - 32 (padding) - 192 (nav) - 32 (gap) = 119px for the
 * entire page body - which is what "the admin side on phone looks nasty"
 * actually was. A drawer needs open/close state, so the nav (and only the
 * nav) moved into a client component; the layout stays a server component and
 * keeps doing the auth check and the pending-approvals count.
 *
 * Two renderings of one item list, never two lists to keep in sync:
 *   - `md:hidden` sticky top bar + slide-over drawer on small screens.
 *   - `hidden md:block` sidebar from 768px up, byte-for-byte the previous
 *     desktop layout.
 * `md:` (not `sm:`) is the breakpoint because 640px - padding - 192px of nav
 * is still a cramped body; the app already uses `md:grid-cols-2` elsewhere
 * (admin/reports) so this introduces no new convention.
 *
 * The drawer's open state is stored as *which path it was opened on*, so
 * "open" is derived rather than synchronized: any navigation changes the
 * pathname and the drawer is closed by construction. That covers a link tap,
 * a back/forward gesture and any programmatic navigation with no effect and
 * no per-link onClick to forget.
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
      <div className="sticky top-0 z-30 -mx-4 flex items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 md:hidden">
        <button
          type="button"
          onClick={openDrawer}
          aria-label="Open the admin menu"
          aria-expanded={open}
          className="-ml-2 rounded-lg p-2 text-[var(--color-text)] hover:bg-[var(--color-surface)]"
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
      </div>

      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          {/* A real <button> rather than a div, so the scrim is dismissible by
           *  keyboard and announced, not just tappable. */}
          <button
            type="button"
            aria-label="Close the admin menu"
            onClick={closeDrawer}
            className="absolute inset-0 bg-black/40"
          />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85%] overflow-y-auto bg-[var(--color-bg)] p-4 shadow-xl">
            <div className="mb-4 flex items-center justify-between gap-2">
              <span className="text-lg font-semibold">Printio Admin</span>
              <button
                type="button"
                onClick={closeDrawer}
                aria-label="Close the admin menu"
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

      <nav className="hidden w-48 shrink-0 md:block">
        <Link href={routes.admin} className="mb-4 block text-lg font-semibold">
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
   * Whether this rendering owns the (single) HelpMenu instance.
   *
   * The sidebar is `hidden md:block` - hidden, but still mounted - so while
   * the drawer is open both renderings exist in the DOM at once. HelpMenu is
   * stateful (it auto-opens the first-login tour and carries the
   * `data-tour="help-button"` spotlight anchor), so a second copy would open a
   * second tour over the first and give document.querySelector two anchors to
   * pick from. The drawer takes it while it's open, the sidebar the rest of
   * the time - on desktop the drawer can never open at all (its trigger is
   * `md:hidden`), so nothing there changes.
   */
  mountHelp: boolean;
}) {
  return (
    <>
      {/* Approvals is the one recurring daily action for both roles, so it's
       *  pinned at the top (not grouped) and gets a live count badge;
       *  everything else is grouped by what it's actually for, not shown as
       *  one flat list. */}
      <ul className="flex flex-col gap-1 text-sm">
        <NavLink href={routes.print} icon={FilePlus} pathname={pathname}>
          Print
        </NavLink>
        <NavLink href={routes.jobs} icon={ListChecks} pathname={pathname}>
          My jobs
        </NavLink>
        <NavLink href={routes.usage} icon={PieChart} pathname={pathname}>
          Usage
        </NavLink>
        <NavLink href={routes.profile} icon={UserRound} pathname={pathname}>
          Profile
        </NavLink>
      </ul>

      <NavGroup title="Admin">
        <NavLink href={routes.admin} icon={LayoutDashboard} pathname={pathname} exact>
          Overview
        </NavLink>
      </NavGroup>

      <NavGroup title="People">
        <NavLink href={routes.adminUsers} icon={Users} pathname={pathname}>
          Users
        </NavLink>
        <NavLink href={routes.adminGroups} icon={FolderKanban} pathname={pathname}>
          Groups
        </NavLink>
      </NavGroup>

      <NavGroup title="Printers">
        <NavLink href={routes.adminPrinters} icon={Printer} pathname={pathname}>
          Printers
        </NavLink>
        <NavLink href={routes.adminAgents} icon={Cpu} pathname={pathname}>
          Agents
        </NavLink>
      </NavGroup>

      <NavGroup title="Rules">
        <NavLink href={routes.adminApprovals} icon={CheckSquare} pathname={pathname}>
          <span className="flex items-center justify-between gap-2">
            Approvals
            {pendingApprovals > 0 && <Badge tone="warning">{pendingApprovals}</Badge>}
          </span>
        </NavLink>
        <NavLink href={routes.adminPolicies} icon={ShieldCheck} pathname={pathname}>
          Policies
        </NavLink>
        <NavLink href={routes.adminQuotas} icon={Gauge} pathname={pathname}>
          Quotas
        </NavLink>
      </NavGroup>

      <NavGroup title="Reports & settings">
        <NavLink href={routes.adminReports} icon={BarChart3} pathname={pathname}>
          Reports
        </NavLink>
        {/* Audit log requires org_admin (app/admin/audit/page.tsx) - hidden
         *  for approvers rather than showing a link that throws for them. */}
        {isOrgAdmin && (
          <NavLink href={routes.adminAudit} icon={ScrollText} pathname={pathname}>
            Audit log
          </NavLink>
        )}
        {/* Storage requires org_admin (app/admin/storage/page.tsx) - hidden
         *  for approvers rather than showing a link that redirects them. */}
        {isOrgAdmin && (
          <NavLink href={routes.adminStorage} icon={HardDrive} pathname={pathname}>
            Storage
          </NavLink>
        )}
        <NavLink href={routes.adminSettings} icon={Globe} pathname={pathname}>
          Settings
        </NavLink>
      </NavGroup>

      <div className="mt-6 flex flex-col gap-1 border-t border-[var(--color-border)] pt-4 text-sm">
        {isSuperAdmin && (
          <Link href={routes.platform} className="block rounded-lg px-3 py-2 hover:bg-[var(--color-surface)]">
            Platform console
          </Link>
        )}
        {/* Exactly one HelpMenu is ever mounted (see mountHelp's own note):
         *  it owns the first-login tour and the `data-tour="help-button"`
         *  anchor, and two copies would auto-open two tours and give the
         *  spotlight two elements to choose between. */}
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

function NavGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-[var(--color-border)] pt-4">
      <p className="mb-1 px-3 text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">{title}</p>
      <ul className="flex flex-col gap-1 text-sm">{children}</ul>
    </div>
  );
}

function NavLink({
  href,
  icon: Icon,
  children,
  pathname,
  exact = false,
}: {
  href: string;
  icon: LucideIcon;
  children: React.ReactNode;
  pathname: string;
  /** /admin itself is a prefix of every other admin route, so only it needs
   *  an exact match to avoid marking "Overview" active on every page. */
  exact?: boolean;
}) {
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={`flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-[var(--color-surface)] ${
          active ? "bg-[var(--color-surface)] font-medium text-[var(--color-primary)]" : ""
        }`}
      >
        <Icon className={`h-4 w-4 shrink-0 ${active ? "text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`} />
        <span className="min-w-0 flex-1">{children}</span>
      </Link>
    </li>
  );
}
