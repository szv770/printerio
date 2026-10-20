import { requireSessionOrRedirect } from "@/lib/auth/session";
import { roleLabel } from "@/lib/role-label";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, Card, Badge } from "@/components/ui";
import { ProfileForm } from "./ProfileForm";

export default async function ProfilePage() {
  const session = await requireSessionOrRedirect();
  const supabase = await createClient();
  const { data: org } = session.membership
    ? await supabase.from("organizations").select("name").eq("id", session.membership.organization_id).single()
    : { data: null };

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <PageHeader title="Profile" />
      <Card className="flex flex-col gap-4">
        <div className="text-sm">
          <p className="text-[var(--color-muted)]">Email</p>
          <p className="font-medium">{session.email}</p>
        </div>
        {session.membership && (
          <div className="flex gap-6 text-sm">
            <div>
              <p className="text-[var(--color-muted)]">Organization</p>
              <p className="font-medium">{org?.name ?? "—"}</p>
            </div>
            <div>
              <p className="text-[var(--color-muted)]">Role</p>
              <Badge tone="neutral">{roleLabel(session.membership.role)}</Badge>
            </div>
            {session.membership.department && (
              <div>
                <p className="text-[var(--color-muted)]">Department</p>
                <p className="font-medium">{session.membership.department}</p>
              </div>
            )}
          </div>
        )}
        <ProfileForm displayName={session.profile.display_name} />
      </Card>
    </main>
  );
}
