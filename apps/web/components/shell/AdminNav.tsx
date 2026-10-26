"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Layers,
  LayoutDashboard,
  CircleCheckBig,
  Users,
  FolderKanban,
  Printer,
  Server,
  Smartphone,
  ShieldCheck,
  Gauge,
  SlidersHorizontal,
  HardDrive,
  BarChart3,
  ScrollText,
  Plus,
  ListChecks,
  PieChart,
  UserRound,
  Menu,
  X,
  ChevronRight,
  Info,
  type LucideIcon,
} from "lucide-react";
import { routes } from "@/lib/routes";
import { HelpMenu } from "@/components/help/HelpMenu";
import {
  PRINT_ITEM,
  activeItemHref,
  adminMenu,
  openGroupIds,
  type NavGroup as NavGroupModel,
  type NavIcon,
  type NavItem,
} from "@/lib/nav";
import { Logo } from "./Logo";
import { InstallCard } from "@/components/pwa/InstallCard";
import { UserChip, type ShellUser } from "./UserChip";

/**
 * The admin shell's navigation: ONE element that is a slide-over drawer on
 * phones and a sticky 240px sidebar from md up (so there is only ever one
 * HelpMenu and one set of data-tour anchors in the DOM). Menu content and the
 * open-group logic live in lib/nav.ts (unit tested).
 *
 * Phones also get a slim sticky top bar (menu, logo, approvals badge, Print).
 * The drawer's open state is stored as the path it was opened on, so any
 * navigation closes it by construction. Escape and the backdrop close it, and
 * the page behind does not scroll while it is open.
 *
 * Groups fold. A group is open when it holds the current page, or when the
 * user toggled it by hand on this page.
 */
export function AdminNav({
  isOrgAdmin,
  isSuperAdmin,
  userId,
  pendingApprovals,
  user,
  pathnameOverride,
}: {
  isOrgAdmin: boolean;
  isSuperAdmin: boolean;
  userId: string;
  pendingApprovals: number;
  user: ShellUser;
  /** Dev preview only: pretend to be on this page. */
  pathnameOverride?: string;
}) {
  const realPathname = usePathname();
  const pathname = pathnameOverride ?? realPathname;
  const [openedOnPath, setOpenedOnPath] = useState<string | null>(null);
  const open = openedOnPath === pathname;
  const closeDrawer = () => setOpenedOnPath(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenedOnPath(null);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <div className="sticky top-0 z-30 flex h-14 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)]/90 px-2 backdrop-blur md:hidden">
        <button
          type="button"
          onClick={() => setOpenedOnPath(pathname)}
          aria-label="Open the menu"
          aria-expanded={open}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-2)] transition-colors hover:bg-[var(--color-surface-2)]"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Link href={routes.admin} aria-label="Printio home" className="min-w-0 flex-1 rounded-lg px-1 py-2">
          <Logo />
        </Link>
        {pendingApprovals > 0 && (
          <Link
            href={routes.adminApprovals}
            className="flex h-11 shrink-0 items-center rounded-lg px-1 text-[13px] font-medium text-[var(--color-warning-ink)]"
          >
            <span className="rounded-full bg-[var(--color-warning-soft)] px-2.5 py-0.5">{pendingApprovals} to approve</span>
          </Link>
        )}
        <Link
          href={PRINT_ITEM.href}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--color-primary)] px-3.5 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] hover:bg-[var(--color-primary-hover)]"
        >
          <Plus className="h-4 w-4" />
          Print
        </Link>
      </div>

      {/* Backdrop: a real button so it is keyboard-dismissible and announced. */}
      <button
        type="button"
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        aria-label="Close the menu"
        onClick={closeDrawer}
        className={`fixed inset-0 z-40 bg-[#0f1729]/40 backdrop-blur-[2px] transition-opacity duration-200 md:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      <aside
        aria-label="Main menu"
        className={`fixed inset-y-0 left-0 z-50 flex w-[17rem] max-w-[86vw] flex-col bg-[var(--color-surface)] shadow-[var(--shadow-pop)] transition-[transform,visibility] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none md:visible md:sticky md:top-0 md:z-auto md:h-screen md:w-60 md:max-w-none md:shrink-0 md:translate-x-0 md:self-start md:border-r md:border-[var(--color-border)] md:shadow-none ${
          open ? "visible translate-x-0" : "invisible -translate-x-full"
        }`}
      >
        <div className="flex h-14 shrink-0 items-center justify-between px-4 md:h-16 md:px-5">
          <Link href={routes.admin} aria-label="Printio home" className="rounded-lg">
            <Logo />
          </Link>
          <button
            type="button"
            onClick={closeDrawer}
            aria-label="Close the menu"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] md:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-3 pb-3">
          <PrintButton pathname={pathname} />
        </div>

        <nav aria-label="Menu" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3 [scrollbar-width:thin]">
          <MenuGroups isOrgAdmin={isOrgAdmin} pathname={pathname} pendingApprovals={pendingApprovals} />
        </nav>

        <div className="shrink-0 border-t border-[var(--color-border)] px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {isSuperAdmin && (
            <Link href={routes.platform} className={`${ROW} text-[var(--color-text-2)] hover:bg-[var(--color-surface-2)]`}>
              <Server className="h-[18px] w-[18px] shrink-0 text-[var(--color-muted)]" strokeWidth={1.75} />
              Platform console
            </Link>
          )}
          <Link href={routes.home} className={`${ROW} text-[var(--color-text-2)] hover:bg-[var(--color-surface-2)]`}>
            <Info className="h-[18px] w-[18px] shrink-0 text-[var(--color-muted)]" strokeWidth={1.75} />
            About Printio
          </Link>
          <div className={`${ROW} text-[var(--color-text-2)] hover:bg-[var(--color-surface-2)] [&_button]:min-h-11 [&_button]:w-full [&_button]:text-sm [&_button]:font-medium md:[&_button]:min-h-10`}>
            <HelpMenu userId={userId} variant="admin" />
          </div>
          <InstallCard
            variant="row"
            rowClassName={`${ROW} text-[var(--color-text-2)] hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]`}
          />
          <UserChip user={user} />
        </div>
      </aside>
    </>
  );
}

const ICONS: Record<NavIcon, LucideIcon> = {
  overview: LayoutDashboard,
  approvals: CircleCheckBig,
  users: Users,
  groups: FolderKanban,
  printers: Printer,
  agents: Server,
  devices: Smartphone,
  policies: ShieldCheck,
  quotas: Gauge,
  reports: BarChart3,
  audit: ScrollText,
  storage: HardDrive,
  settings: SlidersHorizontal,
  print: Plus,
  jobs: ListChecks,
  alljobs: Layers,
  usage: PieChart,
  profile: UserRound,
};

/** One 44px (touch) / 40px (pointer) row; every clickable row in the menu shares it. */
const ROW =
  "relative flex min-h-11 w-full items-center gap-3 rounded-[var(--radius-control)] px-2.5 text-sm font-medium transition-colors md:min-h-10";

function PrintButton({ pathname }: { pathname: string }) {
  const active = activeItemHref(adminMenu(true), pathname) === PRINT_ITEM.href;
  return (
    <Link
      href={PRINT_ITEM.href}
      aria-current={active ? "page" : undefined}
      className="flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-primary)] px-3 text-sm font-medium text-[var(--color-primary-fg)] shadow-[inset_0_1px_0_rgb(255_255_255/0.18),var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:shadow-[var(--ring)] md:min-h-10"
    >
      <Plus className="h-4 w-4" strokeWidth={2.25} />
      Print a document
    </Link>
  );
}

function MenuGroups({
  isOrgAdmin,
  pathname,
  pendingApprovals,
}: {
  isOrgAdmin: boolean;
  pathname: string;
  pendingApprovals: number;
}) {
  const groups = adminMenu(isOrgAdmin);
  const activeHref = activeItemHref(groups, pathname);
  const autoOpen = openGroupIds(groups, pathname);
  // Hand toggles are keyed by pathname, so a new page returns to "auto" (current group open).
  const [toggled, setToggled] = useState<{ path: string; ids: Record<string, boolean> }>({ path: pathname, ids: {} });
  const ids = toggled.path === pathname ? toggled.ids : {};
  const isOpen = (g: NavGroupModel) => ids[g.id] ?? autoOpen.includes(g.id);
  const toggle = (g: NavGroupModel) => setToggled({ path: pathname, ids: { ...ids, [g.id]: !isOpen(g) } });

  const links = (g: NavGroupModel) =>
    g.items.map((item) => (
      <NavLink key={item.href} item={item} active={item.href === activeHref} pendingApprovals={pendingApprovals} />
    ));

  return (
    <div className="flex flex-col gap-0.5">
      {groups.map((group) =>
        group.alwaysOpen || group.title === null ? (
          <ul key={group.id} className="flex flex-col gap-0.5 pb-2">
            {links(group)}
          </ul>
        ) : (
          <FoldGroup key={group.id} group={group} open={isOpen(group)} onToggle={() => toggle(group)}>
            {links(group)}
          </FoldGroup>
        ),
      )}
    </div>
  );
}

function FoldGroup({
  group,
  open,
  onToggle,
  children,
}: {
  group: NavGroupModel;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const panelId = `nav-group-${group.id}`;
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className={`${ROW} justify-between text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]`}
      >
        <span className="text-[13px]">{group.title}</span>
        <ChevronRight
          aria-hidden="true"
          className={`h-4 w-4 transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
      </button>
      <div
        id={panelId}
        inert={!open}
        className={`grid transition-[grid-template-rows,visibility] duration-200 ease-out motion-reduce:transition-none ${
          open ? "visible grid-rows-[1fr]" : "invisible grid-rows-[0fr]"
        }`}
      >
        <ul className="flex min-h-0 flex-col gap-0.5 overflow-hidden">{children}</ul>
      </div>
    </div>
  );
}

function NavLink({
  item,
  active,
  pendingApprovals,
}: {
  item: NavItem;
  active: boolean;
  pendingApprovals: number;
}) {
  const Icon = ICONS[item.icon];
  const count = item.badge === "pendingApprovals" ? pendingApprovals : 0;
  return (
    <li>
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        data-tour={item.tourAnchor}
        className={`${ROW} focus-visible:outline-none focus-visible:shadow-[var(--ring)] ${
          active
            ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
            : "text-[var(--color-text-2)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        }`}
      >
        {active && (
          <span
            aria-hidden="true"
            className="absolute top-1/2 -left-3 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-[var(--color-primary)]"
          />
        )}
        <Icon
          className={`h-[18px] w-[18px] shrink-0 ${active ? "text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`}
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {count > 0 && (
          <span
            aria-label={`${count} waiting`}
            className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-warning-soft)] px-1.5 text-xs font-semibold text-[var(--color-warning-ink)]"
          >
            {count}
          </span>
        )}
      </Link>
    </li>
  );
}
