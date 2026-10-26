import Link from "next/link";
import { redirect } from "next/navigation";
import { LayoutDashboard, Building2, ShieldCheck, type LucideIcon } from "lucide-react";
import { requirePlatformRole } from "@/lib/auth/session";
import { signOutAction } from "@/lib/auth/actions";
import { routes } from "@/lib/routes";

/**
 * Shell for the platform-level super-admin console - deliberately a sibling
 * of app/admin (not nested under it): /admin is scoped to one organization
 * (requireOrgRole), /platform operates across every organization in the
 * deployment (requirePlatformRole) and the two must never share a guard.
 * Visually mirrors app/admin/layout.tsx's nav shape on purpose so the two
 * consoles read as the same product.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  try {
    await requirePlatformRole();
  } catch {
    redirect(routes.start);
  }

  return (
    // Same mobile-first stack as app/admin/layout.tsx: the nav sits above the
    // content on a phone and only becomes a fixed-width sidebar once there is
    // room for one. This console is three links and super-admin-only, so it
    // gets the wrapped-row treatment rather than admin's full drawer.
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-4 px-4 py-4 md:flex-row md:gap-8 md:py-8">
      <nav className="w-full shrink-0 md:w-48">
        <Link href={routes.platform} className="mb-1 block text-lg font-semibold">
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
          <Link href={routes.dashboard} className="block rounded-lg px-3 py-2 hover:bg-[var(--color-surface)]">
            Back to app
          </Link>
          <form action={signOutAction}>
            <button
              type="submit"
              className="block w-full rounded-lg px-3 py-2 text-left text-[var(--color-muted)] hover:bg-[var(--color-surface)]"
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
      <Link href={href} className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-[var(--color-surface)]">
        <Icon className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
        <span className="min-w-0 flex-1">{children}</span>
      </Link>
    </li>
  );
}
