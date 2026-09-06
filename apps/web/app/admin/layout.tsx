import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgRole } from "@/lib/auth/session";
import { signOutAction } from "@/lib/auth/actions";
import { routes } from "@/lib/routes";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireOrgRole(["org_admin", "approver"]);
  } catch {
    redirect(routes.home);
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl gap-8 px-4 py-8">
      <nav className="w-48 shrink-0">
        <Link href={routes.home} className="mb-4 block text-lg font-semibold">
          PrintOS Admin
        </Link>
        <ul className="flex flex-col gap-1 text-sm">
          <NavLink href={routes.admin}>Overview</NavLink>
          <NavLink href={routes.adminApprovals}>Approvals</NavLink>
          <NavLink href={routes.adminUsers}>Users</NavLink>
          <NavLink href={routes.adminGroups}>Groups</NavLink>
          <NavLink href={routes.adminQuotas}>Quotas</NavLink>
          <NavLink href={routes.adminPolicies}>Policies</NavLink>
          <NavLink href={routes.adminPrinters}>Printers</NavLink>
          <NavLink href={routes.adminAgents}>Agents</NavLink>
          <NavLink href={routes.adminReports}>Reports</NavLink>
          <NavLink href={routes.adminAudit}>Audit log</NavLink>
        </ul>
        <div className="mt-6 flex flex-col gap-1 border-t border-[var(--color-border)] pt-4 text-sm">
          <Link href={routes.print} className="block rounded-lg px-3 py-2 hover:bg-[var(--color-surface)]">
            Switch to student view
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

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li>
      <Link href={href} className="block rounded-lg px-3 py-2 hover:bg-[var(--color-surface)]">
        {children}
      </Link>
    </li>
  );
}
