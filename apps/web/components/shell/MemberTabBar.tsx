"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Home, ListChecks, LogOut, PieChart, Printer, Smartphone, UserRound, X, type LucideIcon } from "lucide-react";
import { signOutAction } from "@/lib/auth/actions";
import { routes } from "@/lib/routes";
import { isActiveHref, TOUR_ANCHORS } from "@/lib/nav";
import { InstallCard } from "@/components/pwa/InstallCard";
import { UserChip, type ShellUser } from "./UserChip";

interface Tab {
  href: string;
  label: string;
  Icon: LucideIcon;
  tour?: string;
}

const TABS: Tab[] = [
  { href: routes.dashboard, label: "Home", Icon: Home },
  { href: routes.print, label: "Print", Icon: Printer },
  { href: routes.jobs, label: "My jobs", Icon: ListChecks, tour: TOUR_ANCHORS.myJobs },
];

const ME_LINKS: Tab[] = [
  { href: routes.profile, label: "Profile", Icon: UserRound },
  { href: routes.usage, label: "My usage", Icon: PieChart },
  { href: routes.devices, label: "My devices", Icon: Smartphone },
];

/**
 * The phone app's bottom tab bar for members: Home, Print, My jobs and Me.
 * "Me" opens a sheet with the rest (profile, usage, devices, sign out), so
 * nothing the old header offered is lost. Hidden from sm up, where the header
 * strip takes over. `tourAnchor` says whether this bar (a phone) or the strip
 * owns the `nav-my-jobs` spotlight, so exactly one element carries it.
 */
export function MemberTabBar({
  pathname,
  user,
  tourAnchor,
}: {
  pathname: string;
  user: ShellUser;
  tourAnchor: boolean;
}) {
  const [sheetPath, setSheetPath] = useState<string | null>(null);
  const sheetOpen = sheetPath === pathname;
  const meActive = ME_LINKS.some((l) => isActiveHref(l.href, pathname));

  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSheetPath(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  const tabClass = (active: boolean) =>
    `relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-primary)] ${
      active ? "text-[var(--color-primary)]" : "text-[var(--color-muted)]"
    }`;

  return (
    <div className="sm:hidden">
      <button
        type="button"
        tabIndex={sheetOpen ? 0 : -1}
        aria-hidden={!sheetOpen}
        aria-label="Close"
        onClick={() => setSheetPath(null)}
        className={`fixed inset-0 z-40 bg-[#17150f]/40 transition-opacity duration-200 ${
          sheetOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <div
        role={sheetOpen ? "dialog" : undefined}
        aria-label="Me"
        inert={!sheetOpen}
        className={`fixed inset-x-0 bottom-0 z-50 rounded-t-[1.75rem] bg-[var(--color-surface)] px-4 pt-3 pb-[calc(4.5rem+env(safe-area-inset-bottom))] shadow-[var(--shadow-pop)] transition-[transform,visibility] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
          sheetOpen ? "visible translate-y-0" : "invisible translate-y-full"
        }`}
      >
        <div className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-[var(--color-border-strong)]" aria-hidden="true" />
        <div className="mb-1 flex items-center justify-between">
          <UserChip user={user} />
          <button
            type="button"
            aria-label="Close"
            onClick={() => setSheetPath(null)}
            className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <ul className="flex flex-col">
          {ME_LINKS.map(({ href, label, Icon }) => (
            <li key={href}>
              <Link
                href={href}
                className="flex min-h-12 items-center gap-3 rounded-[var(--radius-control)] px-3 text-[15px] font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
              >
                <Icon className="h-5 w-5 text-[var(--color-muted)]" strokeWidth={1.75} />
                {label}
              </Link>
            </li>
          ))}
          <li>
            <InstallCard variant="row" />
          </li>
          <li>
            <form action={signOutAction}>
              <button
                type="submit"
                className="flex min-h-12 w-full items-center gap-3 rounded-[var(--radius-control)] px-3 text-[15px] font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
              >
                <LogOut className="h-5 w-5 text-[var(--color-muted)]" strokeWidth={1.75} />
                Sign out
              </button>
            </form>
          </li>
        </ul>
      </div>

      <nav
        aria-label="Main menu"
        className="fixed inset-x-0 bottom-0 z-[60] flex border-t border-[var(--color-border)] bg-[var(--color-surface)]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
      >
        {TABS.map(({ href, label, Icon, tour }) => {
          const active = isActiveHref(href, pathname);
          const isPrint = href === routes.print;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              data-tour={tourAnchor ? tour : undefined}
              className={tabClass(active)}
            >
              {isPrint ? (
                <span className="-mt-5 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-primary)] text-white shadow-[0_6px_16px_-4px_rgb(10_100_216/0.6)]">
                  <Icon className="h-5 w-5" strokeWidth={2} />
                </span>
              ) : (
                <Icon className="h-[22px] w-[22px]" strokeWidth={active ? 2.25 : 1.75} />
              )}
              <span className={isPrint ? "text-[var(--color-primary)]" : ""}>{label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          aria-expanded={sheetOpen}
          onClick={() => setSheetPath(sheetOpen ? null : pathname)}
          className={tabClass(meActive || sheetOpen)}
        >
          <UserRound className="h-[22px] w-[22px]" strokeWidth={meActive || sheetOpen ? 2.25 : 1.75} />
          <span>Me</span>
        </button>
      </nav>
    </div>
  );
}
