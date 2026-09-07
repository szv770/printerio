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
    redirect(routes.home);
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl gap-8 px-4 py-8">
      <nav className="w-48 shrink-0">
        <Link href={routes.platform} className="mb-1 block text-lg font-semibold">
          Printio Platform
        </Link>
        <p className="mb-4 text-xs text-[var(--color-muted)]">Signed in as super admin</p>
        <ul className="flex flex-col gap-1 text-sm">
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

        <div className="mt-6 flex flex-col gap-1 border-t border-[var(--color-border)] pt-4 text-sm">
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
