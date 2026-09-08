import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui";

export default async function AuditPage() {
  const session = await requireOrgRole(["org_admin"]);
  const supabase = await createClient();

  const { data: logs } = await supabase
    .from("audit_logs")
    .select("*")
    .eq("organization_id", session.membership.organization_id)
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <div>
      <PageHeader title="Audit log" />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted)]">
              <th className="py-2 pr-4">When</th>
              <th className="py-2 pr-4">Action</th>
              <th className="py-2 pr-4">Target</th>
              <th className="py-2 pr-4">Metadata</th>
            </tr>
          </thead>
          <tbody>
            {(logs ?? []).map((log) => (
              <tr key={log.id} className="border-b border-[var(--color-border)] align-top">
                <td className="py-2 pr-4 whitespace-nowrap">{new Date(log.created_at).toLocaleString()}</td>
                <td className="py-2 pr-4">{log.action}</td>
                <td className="py-2 pr-4">
                  {log.target_type ? `${log.target_type}:${log.target_id}` : "—"}
                </td>
                <td className="py-2 pr-4">
                  <pre className="max-w-xs overflow-x-auto text-xs">{JSON.stringify(log.metadata)}</pre>
                </td>
              </tr>
            ))}
            {(!logs || logs.length === 0) && (
              <tr>
                <td colSpan={4} className="py-4 text-center text-[var(--color-muted)]">
                  No audit events yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
