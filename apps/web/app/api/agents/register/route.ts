import { apiError } from "@/lib/api-errors";
import { generateDeviceSecret, hashDeviceSecret } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { logger } from "@/lib/logger";

/** One-time: exchanges an admin-issued enrollment code for a device secret.
 *  See docs/agent-api.md. No Authorization header on this endpoint - the
 *  enrollment code itself is the (single-use, expiring) credential, so this
 *  route is rate-limited per source IP to slow down brute-force guessing
 *  (the code has 48 bits of entropy per lib/auth/invitations.ts, but this is
 *  cheap defense in depth - see supabase/migrations/0012_rate_limiting.sql). */
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

  // x-forwarded-for's first entry is the original client per Vercel's edge
  // network; falls back to a shared bucket (still rate-limited, just
  // coarser) if it's ever absent rather than skipping the check entirely.
  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const { data: withinLimit, error: rateLimitError } = await supabase.rpc("check_rate_limit", {
    p_key: `agent_register:${clientIp}`,
    p_max_count: 10,
    p_window_seconds: 300,
  });
  if (rateLimitError) {
    logger.error("rate limit check failed", { route: "agents/register", error: rateLimitError.message });
  } else if (!withinLimit) {
    return apiError(429, "rate_limited", "Too many registration attempts. Try again later.");
  }
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
