import Link from "next/link";
import { redirect } from "next/navigation";
import {
  LayoutDashboard,
  CheckSquare,
  Users,
  FolderKanban,
  Printer,
  Cpu,
  ShieldCheck,
  Gauge,
  Globe,
  BarChart3,
  ScrollText,
  type LucideIcon,
} from "lucide-react";
import { requireOrgRole } from "@/lib/auth/session";
import { signOutAction } from "@/lib/auth/actions";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { Badge } from "@/components/ui";
import { HelpMenu } from "@/components/help/HelpMenu";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let isOrgAdmin = false;
  let organizationId: string | null = null;
  let userId = "";
  try {
    const session = await requireOrgRole(["org_admin", "approver"]);
    isOrgAdmin = session.membership.role === "org_admin";
    organizationId = session.membership.organization_id;
    userId = session.userId;
  } catch {
    redirect(routes.home);
  }

  // Approvals is the one recurring daily action for both roles, so it's
  // pinned at the top (not grouped) and gets a live count badge; everything
  // else is grouped by what it's actually for, not shown as one flat list.
  const supabase = await createClient();
  const { count: pendingApprovals } = await supabase
    .from("print_jobs")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("status", "pending_approval");

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl gap-8 px-4 py-8">
      <nav className="w-48 shrink-0">
        <Link href={routes.home} className="mb-4 block text-lg font-semibold">
          PrintOS Admin
        </Link>
        <ul className="flex flex-col gap-1 text-sm">
          <NavLink href={routes.admin} icon={LayoutDashboard}>
            Overview
          </NavLink>
          <NavLink href={routes.adminApprovals} icon={CheckSquare}>
            <span className="flex items-center justify-between">
              Approvals
              {!!pendingApprovals && <Badge tone="warning">{pendingApprovals}</Badge>}
            </span>
          </NavLink>
        </ul>

        <NavGroup title="People">
          <NavLink href={routes.adminUsers} icon={Users}>
            Users
          </NavLink>
          <NavLink href={routes.adminGroups} icon={FolderKanban}>
            Groups
          </NavLink>
        </NavGroup>

        <NavGroup title="Print infrastructure">
          <NavLink href={routes.adminPrinters} icon={Printer}>
            Printers
          </NavLink>
          <NavLink href={routes.adminAgents} icon={Cpu}>
            Agents
          </NavLink>
        </NavGroup>

        <NavGroup title="Governance">
          <NavLink href={routes.adminPolicies} icon={ShieldCheck}>
            Policies
          </NavLink>
          <NavLink href={routes.adminQuotas} icon={Gauge}>
            Quotas
          </NavLink>
          <NavLink href={routes.adminSettings} icon={Globe}>
            Settings
          </NavLink>
        </NavGroup>

        <NavGroup title="Insights">
          <NavLink href={routes.adminReports} icon={BarChart3}>
            Reports
          </NavLink>
          {/* Audit log requires org_admin (app/admin/audit/page.tsx) - hidden
           *  for approvers rather than showing a link that throws for them. */}
          {isOrgAdmin && (
            <NavLink href={routes.adminAudit} icon={ScrollText}>
              Audit log
            </NavLink>
          )}
        </NavGroup>

        <div className="mt-6 flex flex-col gap-1 border-t border-[var(--color-border)] pt-4 text-sm">
          <Link href={routes.dashboard} className="block rounded-lg px-3 py-2 hover:bg-[var(--color-surface)]">
            Switch to student view
          </Link>
          <div className="px-3 py-2">
            <HelpMenu userId={userId} variant="admin" />
          </div>
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

function NavGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-[var(--color-border)] pt-4">
      <p className="mb-1 px-3 text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">{title}</p>
      <ul className="flex flex-col gap-1 text-sm">{children}</ul>
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
