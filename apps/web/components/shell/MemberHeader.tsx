"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { Server } from "lucide-react";
import { routes } from "@/lib/routes";
import { isActiveHref, memberMenu } from "@/lib/nav";
import { HelpMenu } from "@/components/help/HelpMenu";
import { Logo } from "./Logo";
import { MemberTabBar } from "./MemberTabBar";
import { UserChip, type ShellUser } from "./UserChip";

const WIDE = "(min-width: 640px)";
function subscribeWide(cb: () => void) {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/**
 * The header plain members get (no admin menu). Items come from lib/nav.ts.
 * sm and up: logo, a strip of pills, help and the account chip. Phones: just a
 * slim bar (logo + help) and the bottom tab bar (MemberTabBar). The My jobs
 * `data-tour` anchor lives on whichever of the two is on screen.
 */
export function MemberHeader({
  userId,
  isSuperAdmin,
  user,
  pathnameOverride,
}: {
  userId: string;
  isSuperAdmin: boolean;
  user: ShellUser;
  /** Dev preview only: pretend to be on this page. */
  pathnameOverride?: string;
}) {
  const realPathname = usePathname();
  const pathname = pathnameOverride ?? realPathname;
  const wide = useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
  return (
    <>
      <header className="sticky top-0 z-30 border-b border-[var(--color-border)] bg-[var(--color-surface)]/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-4 px-4">
          <Link href={routes.dashboard} aria-label="Printio home" className="flex min-h-11 items-center rounded-lg">
            <Logo />
          </Link>

          <nav aria-label="Menu" className="hidden flex-1 sm:block">
            <ul className="flex items-center gap-1">
              {memberMenu().map((item) => {
                const active = isActiveHref(item.href, pathname);
                const primary = item.href === routes.print;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      data-tour={wide ? item.tourAnchor : undefined}
                      aria-current={active ? "page" : undefined}
                      className={`flex min-h-9 items-center rounded-[var(--radius-control)] px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:shadow-[var(--ring)] ${
                        active
                          ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                          : primary
                            ? "text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]"
                            : "text-[var(--color-text-2)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
              {isSuperAdmin && (
                <li>
                  <Link
                    href={routes.platform}
                    className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] px-3 text-sm font-medium text-[var(--color-text-2)] hover:bg-[var(--color-surface-2)]"
                  >
                    <Server className="h-4 w-4 text-[var(--color-muted)]" aria-hidden="true" />
                    Platform
                  </Link>
                </li>
              )}
            </ul>
          </nav>

          <div className="flex items-center gap-1">
            <div className="flex min-h-11 items-center text-sm font-medium [&_button]:min-h-11 [&_button]:px-2 [&_button]:text-sm sm:min-h-9 sm:[&_button]:min-h-9">
              <HelpMenu userId={userId} variant="student" />
            </div>
            {/* Avatar + sign out only (the phone has the Me sheet instead). */}
            <div className="hidden sm:block [&>div]:p-0 [&>div>span:nth-child(2)]:hidden">
              <UserChip user={user} />
            </div>
          </div>
        </div>
      </header>
      <MemberTabBar pathname={pathname} user={user} tourAnchor={!wide} />
    </>
  );
}
