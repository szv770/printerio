import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ZodType } from "zod";
import type { Database } from "@/lib/database.types";
import { getGatewayEnv } from "@/lib/env";
import { DEVICE_COLUMNS, type DeviceRow } from "@/lib/devices/devices";
import { friendlyFailureMessage } from "@/lib/job-failure";
import { jobWaiting } from "@/lib/job-waiting";

/** Shared plumbing for the /api/gateway/* route handlers (docs/superpowers/specs/2026-10-22-gateway-contract.md). */

type Client = SupabaseClient<Database>;

/** The contract's error shape: `{ error: "<code>", message: "<plain words>" }`. */
export function gatewayError(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time string comparison that does not leak length (both sides are hashed to 32 bytes first). */
export function secretsMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(sha256(provided), sha256(expected));
}

/**
 * Checks `Authorization: Bearer <GATEWAY_SHARED_SECRET>`. Returns null when the caller is the gateway, otherwise
 * the response to send: 401 for a missing/wrong secret, 503 when this deployment has no secret configured (so a
 * misconfiguration is visible, and nothing can ever authenticate against an unset secret).
 */
export function authenticateGateway(request: Request): Response | null {
  let secret: string | null;
  try {
    secret = getGatewayEnv().sharedSecret;
  } catch {
    secret = null;
  }
  if (!secret) return gatewayError(503, "gateway_not_configured", "The gateway is not set up on this server yet.");

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!provided || !secretsMatch(provided, secret)) {
    return gatewayError(401, "unauthorized", "Missing or wrong gateway credentials.");
  }
  return null;
}

/** Parses the JSON body with a zod schema. Never throws: a bad body is a 400 response. */
export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: gatewayError(400, "invalid_json", "The request body must be JSON.") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? ` (${first.path.join(".")})` : "";
    return { ok: false, response: gatewayError(400, "invalid_request", `The request was not understood${where}.`) };
  }
  return { ok: true, data: parsed.data };
}

export interface ActiveMember {
  userId: string;
  organizationId: string;
  role: string;
  department: string | null;
}

export type DeviceLookup =
  | { ok: true; device: DeviceRow; member: ActiveMember }
  | { ok: false; response: Response };

/**
 * Never trust a deviceId from the request: it must exist, not be revoked, and its owner must still be an active
 * member of the device's organization. Returns the member the job runs as.
 */
export async function loadUsableDevice(supabase: Client, deviceId: string): Promise<DeviceLookup> {
  const { data: device, error } = await supabase.from("member_devices").select(DEVICE_COLUMNS).eq("id", deviceId).maybeSingle();
  if (error) return { ok: false, response: gatewayError(500, "internal_error", "Could not look up the device.") };
  if (!device) return { ok: false, response: gatewayError(404, "unknown_device", "This device is not registered.") };
  return checkDeviceUsable(supabase, device as unknown as DeviceRow);
}

export async function checkDeviceUsable(supabase: Client, device: DeviceRow): Promise<DeviceLookup> {
  if (device.revoked_at) {
    return { ok: false, response: gatewayError(403, "revoked", "This device was turned off. Add it again from My devices.") };
  }
  const { data: membership, error } = await supabase
    .from("organization_members")
    .select("organization_id, user_id, role, department, status")
    .eq("user_id", device.user_id)
    .eq("organization_id", device.organization_id)
    .maybeSingle();
  if (error) return { ok: false, response: gatewayError(500, "internal_error", "Could not look up the device's user.") };
  if (!membership || membership.status !== "active") {
    return { ok: false, response: gatewayError(403, "inactive_member", "The user this device belongs to can no longer print.") };
  }
  return {
    ok: true,
    device,
    member: {
      userId: membership.user_id,
      organizationId: membership.organization_id,
      role: membership.role,
      department: membership.department,
    },
  };
}

/** What the sender sees next to a job's state, in plain words. */
export function jobMessage(input: {
  status: string;
  heldReason?: string | null;
  policyReasons?: string[] | null;
  errorMessage?: string | null;
}): string | undefined {
  switch (input.status) {
    case "held":
      return input.heldReason || "Waiting for you to choose how to print it on the website.";
    case "pending_approval":
      return "Waiting for approval before it prints.";
    case "denied":
      return input.policyReasons?.[0] || "Your organization's print rules do not allow this job.";
    case "rejected":
      return "An approver declined this job.";
    case "expired":
      return "This job waited too long and was cancelled.";
    case "failed":
      return friendlyFailureMessage(input.errorMessage);
    default:
      // Queued but the printer could not take it yet: say why (plain words). Otherwise a queued job has no message.
      return jobWaiting(input.status, input.errorMessage)?.text;
  }
}

/** "unavailable" | "unknown" while a queued job is waiting for the printer (see lib/job-waiting.ts), else undefined. */
export function jobWaitingKind(input: { status: string; errorMessage?: string | null }): "unavailable" | "unknown" | undefined {
  return jobWaiting(input.status, input.errorMessage)?.kind;
}
