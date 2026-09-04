import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgRole } from "@/lib/auth/session";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireOrgRole(["org_admin", "approver"]);
  } catch {
    redirect("/");
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl gap-8 px-4 py-8">
      <nav className="w-48 shrink-0">
        <p className="mb-4 text-lg font-semibold">PrintOS Admin</p>
        <ul className="flex flex-col gap-1 text-sm">
          <NavLink href="/admin">Overview</NavLink>
          <NavLink href="/admin/approvals">Approvals</NavLink>
          <NavLink href="/admin/users">Users</NavLink>
          <NavLink href="/admin/policies">Policies</NavLink>
          <NavLink href="/admin/printers">Printers</NavLink>
          <NavLink href="/admin/agents">Agents</NavLink>
          <NavLink href="/admin/audit">Audit log</NavLink>
        </ul>
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
