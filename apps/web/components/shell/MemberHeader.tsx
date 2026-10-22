import Link from "next/link";
import { signOutAction } from "@/lib/auth/actions";
import { routes } from "@/lib/routes";
import { memberMenu } from "@/lib/nav";
import { HelpMenu } from "@/components/help/HelpMenu";

/** The simple header plain members get (no admin menu). Items come from lib/nav.ts. */
export function MemberHeader({ userId, isSuperAdmin }: { userId: string; isSuperAdmin: boolean }) {
  return (
    <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-medium">
          <Link href={routes.dashboard} className="font-semibold">
            Printio
          </Link>
          {memberMenu().map((item) => (
            <Link
              key={item.href}
              href={item.href}
              data-tour={item.tourAnchor}
              className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
            >
              {item.label}
            </Link>
          ))}
          {isSuperAdmin && (
            <Link href={routes.platform} className="text-[var(--color-primary)]">
              Platform
            </Link>
          )}
        </nav>
        <div className="flex items-center gap-4">
          <HelpMenu userId={userId} variant="student" />
          <form action={signOutAction}>
            <button type="submit" className="text-sm text-[var(--color-muted)] hover:text-[var(--color-text)]">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
