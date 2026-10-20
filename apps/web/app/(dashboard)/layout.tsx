import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
import { signOutAction } from "@/lib/auth/actions";
import { routes } from "@/lib/routes";
import { HelpMenu } from "@/components/help/HelpMenu";

/** Shared shell for the student/staff-facing pages (Print, My Jobs, Usage,
 *  Profile - spec sec 29). Previously /print and /jobs had no nav between
 *  them and no way to sign out at all. */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();
  if (!session) redirect(routes.login);
  if (!session.membership) redirect(routes.noAccess);

  const isAdmin = session.membership.role === "org_admin" || session.membership.role === "approver";
  const isSuperAdmin = session.profile.platform_role === "super_admin";

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-medium">
            <Link href={routes.home} className="font-semibold">
              Printio
            </Link>
            <Link href={routes.print} className="text-[var(--color-muted)] hover:text-[var(--color-text)]">
              Print
            </Link>
            <Link
              href={routes.jobs}
              data-tour="nav-my-jobs"
              className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
            >
              My jobs
            </Link>
            <Link href={routes.usage} className="text-[var(--color-muted)] hover:text-[var(--color-text)]">
              Usage
            </Link>
            <Link href={routes.profile} className="text-[var(--color-muted)] hover:text-[var(--color-text)]">
              Profile
            </Link>
            {isAdmin && (
              <Link href={routes.admin} className="text-[var(--color-primary)]">
                Admin
              </Link>
            )}
            {isSuperAdmin && (
              <Link href={routes.platform} className="text-[var(--color-primary)]">
                Platform
              </Link>
            )}
          </nav>
          <div className="flex items-center gap-4">
            <HelpMenu userId={session.userId} variant="student" />
            <form action={signOutAction}>
              <button type="submit" className="text-sm text-[var(--color-muted)] hover:text-[var(--color-text)]">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
