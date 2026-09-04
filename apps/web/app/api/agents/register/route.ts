import { apiError } from "@/lib/api-errors";
import { generateDeviceSecret, hashDeviceSecret } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

/** One-time: exchanges an admin-issued enrollment code for a device secret.
 *  See docs/agent-api.md. No Authorization header on this endpoint - the
 *  enrollment code itself is the (single-use, expiring) credential. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "invalid_json", "Request body must be JSON.");
  }
  const enrollmentCode = (body as { enrollmentCode?: unknown })?.enrollmentCode;
  if (typeof enrollmentCode !== "string" || !enrollmentCode) {
    return apiError(400, "missing_enrollment_code", "enrollmentCode is required.");
  }

  const supabase = createServiceRoleClient();
  const { data: agent, error } = await supabase
    .from("agents")
    .select("*")
    .eq("enrollment_code", enrollmentCode)
    .maybeSingle();

  if (error || !agent) return apiError(404, "invalid_code", "Enrollment code not found.");
  if (agent.enrollment_code_expires_at && new Date(agent.enrollment_code_expires_at).getTime() < Date.now()) {
    return apiError(410, "code_expired", "Enrollment code has expired. Ask an administrator for a new one.");
  }
  if (agent.status === "disabled") {
    return apiError(403, "agent_disabled", "This agent has been disabled by an administrator.");
  }

  const deviceSecret = generateDeviceSecret();
  const { error: updateError } = await supabase
    .from("agents")
    .update({
      device_secret_hash: hashDeviceSecret(deviceSecret),
      enrollment_code: null,
      enrollment_code_expires_at: null,
      status: "active",
    })
    .eq("id", agent.id);

  if (updateError) return apiError(500, "internal_error", "Failed to complete registration.");

  await supabase.from("audit_logs").insert({
    organization_id: agent.organization_id,
    action: "agent.registered",
    target_type: "agents",
    target_id: agent.id,
    metadata: {},
  });

  return Response.json({ agentId: agent.id, deviceSecret, organizationId: agent.organization_id });
}
