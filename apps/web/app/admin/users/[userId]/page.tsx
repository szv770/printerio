import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { Card, PageHeader } from "@/components/ui";
import { MemberDetailControls } from "./MemberDetailControls";
import { MemberAccessCard } from "./MemberAccessCard";
import { EarlyToolsCard } from "./EarlyToolsCard";
import { CancelQueueCard } from "./CancelQueueCard";
import { ACTIVITY_WINDOW_DAYS, loadPersonDetail } from "@/lib/admin/person-detail";

/** The full, shareable view of one person (the People list opens the same content in a side panel). Loaded by
 *  loadPersonDetail, scoped to the admin's own organization from the session. */
export default async function MemberDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();
  const isOrgAdmin = session.membership.role === "org_admin";

  const person = await loadPersonDetail(supabase, { organizationId: session.membership.organization_id, userId, isOrgAdmin });
  if (!person) notFound();

  const displayName = person.displayName;
  const email = person.email;
  const firstName = (displayName ?? email).split(/[\s@]/)[0];

  return (
    <div className="max-w-3xl">
      <Link
        href={routes.adminUsers}
        className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--color-muted)] hover:underline"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to users
      </Link>

      <PageHeader title={displayName ?? email} description={displayName ? email : undefined} />

      <Card className="mb-4">
        <MemberDetailControls
          member={{
            userId: person.userId,
            role: person.role,
            status: person.status,
            department: person.department,
          }}
          canEdit={isOrgAdmin}
        />
      </Card>

      <MemberAccessCard groups={person.groups.map((g) => g.name)} access={person.access} firstName={firstName ?? "This person"} />

      <EarlyToolsCard
        userId={person.userId}
        isAdmin={person.role === "org_admin"}
        enabled={person.earlyTools}
        canEdit={isOrgAdmin}
        firstName={firstName ?? "this person"}
      />

      {isOrgAdmin && <CancelQueueCard userId={person.userId} firstName={firstName ?? "this person"} />}

      <Card className="mb-4 text-sm">
        <p className="text-[var(--color-muted)]">Joined</p>
        <p className="font-medium">{new Date(person.joinedAt).toLocaleDateString()}</p>
      </Card>

      <Card className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-[var(--color-muted)]">Print jobs (last {ACTIVITY_WINDOW_DAYS} days)</p>
          <p className="text-lg font-semibold">{person.jobCount}</p>
        </div>
        <div>
          <p className="text-[var(--color-muted)]">Pages (last {ACTIVITY_WINDOW_DAYS} days)</p>
          <p className="text-lg font-semibold">{person.totalPages}</p>
        </div>
      </Card>
    </div>
  );
}
