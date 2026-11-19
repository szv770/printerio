import Link from "next/link";
import { LayoutDashboard, Building2, ShieldCheck, type LucideIcon } from "lucide-react";
import { signOutAction } from "@/lib/auth/actions";
import { routes } from "@/lib/routes";

/** Presentation of the platform console frame (nav + content column). Auth lives in layout.tsx; the dev preview reuses this. */
export function PlatformShell({ children }: { children: React.ReactNode }) {
  return (
    // Same mobile-first stack as app/admin/layout.tsx: the nav sits above the
    // content on a phone and only becomes a fixed-width sidebar once there is
    // room for one. This console is three links and super-admin-only, so it
    // gets the wrapped-row treatment rather than admin's full drawer.
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-4 px-4 py-4 md:flex-row md:gap-8 md:py-8">
      <nav className="w-full shrink-0 md:w-48">
        <Link href={routes.platform} className="-mx-1 mb-0 block rounded-[var(--radius-control)] px-1 py-2 text-lg font-semibold">
          Printio Platform
        </Link>
        <p className="mb-4 text-xs text-[var(--color-muted)]">Signed in as super admin</p>
        <ul className="flex flex-wrap gap-1 text-sm md:flex-col">
          <NavLink href={routes.platform} icon={LayoutDashboard}>
            Overview
          </NavLink>
          <NavLink href={routes.platformNewOrganization} icon={Building2}>
            Create organization
          </NavLink>
          <NavLink href={routes.platformSuperAdmins} icon={ShieldCheck}>
            Super admins
          </NavLink>
        </ul>

        <div className="mt-4 flex flex-wrap gap-1 border-t border-[var(--color-border)] pt-4 text-sm md:mt-6 md:flex-col">
          <Link href={routes.dashboard} className="flex min-h-11 items-center rounded-[var(--radius-control)] px-3 py-2 hover:bg-[var(--color-surface)] md:min-h-0">
            Back to app
          </Link>
          <form action={signOutAction}>
            <button
              type="submit"
              className="flex min-h-11 w-full items-center rounded-[var(--radius-control)] px-3 py-2 text-left text-sm text-[var(--color-muted)] hover:bg-[var(--color-surface)] md:min-h-0"
            >
              Sign out
            </button>
          </form>
        </div>
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function NavLink({ href, icon: Icon, children }: { href: string; icon: LucideIcon; children: React.ReactNode }) {
  return (
    <li>
      <Link href={href} className="flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 hover:bg-[var(--color-surface)] md:min-h-0">
        <Icon className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
        <span className="min-w-0 flex-1">{children}</span>
      </Link>
    </li>
  );
}
