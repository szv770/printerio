import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { auditDetails, truncationNote } from "@/lib/admin/reports-view";
import { AuditView } from "./AuditView";

/** How many events the page reads. Said out loud when reached, never silent. */
const AUDIT_ROW_LIMIT = 200;

export default async function AuditPage() {
  const session = await requireOrgRole(["org_admin"]);
  const supabase = await createClient();
  const orgId = session.membership.organization_id;

  const [{ data: logs }, { data: members }] = await Promise.all([
    supabase
      .from("audit_logs")
      .select("id, created_at, actor_id, action, metadata")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(AUDIT_ROW_LIMIT),
    supabase.from("organization_members").select("user_id, profiles(email, display_name)").eq("organization_id", orgId),
  ]);

  const nameById = new Map((members ?? []).map((m) => [m.user_id, m.profiles?.display_name ?? m.profiles?.email ?? "Someone"]));

  return (
    <AuditView
      truncated={truncationNote((logs ?? []).length, AUDIT_ROW_LIMIT, "latest")}
      rows={(logs ?? []).map((l) => ({
        id: l.id,
        createdAt: l.created_at,
        who: l.actor_id ? (nameById.get(l.actor_id) ?? "Someone who left") : "The system",
        action: l.action,
        details: auditDetails(l.metadata),
      }))}
    />
  );
}
