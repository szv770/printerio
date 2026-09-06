import { apiError } from "@/lib/api-errors";
import { requireOrgRole, AuthError } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { issueRemoteCommand } from "@/lib/remote-commands";

interface IssueCommandBody {
  agentId?: string;
  printerId?: string;
  command?: string;
  payload?: Record<string, unknown>;
}

/**
 * Admin-issued remote command (docs/architecture.md sec 12/18/48), for any
 * external caller with an admin session. The dashboard's own "Refresh
 * status"/"Restart queue" buttons go through Server Actions instead (see
 * app/admin/printers/actions.ts, app/admin/agents/actions.ts) so they don't
 * need a same-origin fetch() call - both paths share lib/remote-commands.ts.
 */
export async function POST(request: Request) {
  let session;
  try {
    session = await requireOrgRole(["org_admin"]);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code === "UNAUTHENTICATED" ? 401 : 403, err.code, err.message);
    throw err;
  }

  let body: IssueCommandBody;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "invalid_json", "Request body must be JSON.");
  }
  if (!body.agentId) return apiError(400, "missing_agent", "agentId is required.");

  const supabase = await createClient();
  const result = await issueRemoteCommand(supabase, {
    organizationId: session.membership.organization_id,
    issuedBy: session.userId,
    agentId: body.agentId,
    printerId: body.printerId,
    command: body.command ?? "",
    payload: body.payload,
  });

  if (!result.ok) return apiError(400, "invalid_request", result.error);
  return Response.json({ ok: true, commandId: result.commandId });
}
