import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deviceHostname, generateDeviceToken, hashDeviceToken } from "@printio/shared/device-token";
import type { Database, Tables } from "@/lib/database.types";
import { validateIssueInput, validateResolveNote } from "./admin";

/**
 * Server-side helpers for member devices (the IPP gateway's "My devices"; pages come later).
 *
 * `token_hash` is never selected here: every read goes through DEVICE_COLUMNS, which matches the column-level
 * SELECT grant the browser roles have (supabase/migrations/0032_member_devices.sql). Callers pass either the
 * member's own client (RLS decides what they see) or the service-role client.
 */

type Client = SupabaseClient<Database>;

export const DEVICE_TYPES = ["windows", "android", "chromebook", "iphone", "mac", "other"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/** A device row without its token hash. */
export type DeviceRow = Omit<Tables<"member_devices">, "token_hash">;

export const DEVICE_COLUMNS =
  "id, organization_id, user_id, name, device_type, created_at, revoked_at, first_seen_at, last_seen_at, last_user_agent, first_job_at, first_printed_at";

/** The event types the gateway reports (contract: POST /api/gateway/events). */
export const DEVICE_EVENT_TYPES = ["attributes_requested", "job_received", "job_rejected", "info"] as const;
export type DeviceEventType = (typeof DEVICE_EVENT_TYPES)[number];

/** Keep a device's event log small: older rows beyond this are pruned as new ones arrive. */
export const MAX_EVENTS_PER_DEVICE = 200;

const MAX_NAME_LENGTH = 80;
const MAX_USER_AGENT_LENGTH = 300;

export type CreateDeviceResult =
  | {
      ok: true;
      device: DeviceRow;
      /** The raw token. Show it once; only its hash is stored. */
      token: string;
      /** u-<token>.<base domain>: the address the member adds as a printer. */
      hostname: string;
    }
  | { ok: false; error: string };

export async function createDevice(
  supabase: Client,
  input: { organizationId: string; userId: string; name: string; deviceType: string; baseDomain: string | null | undefined },
): Promise<CreateDeviceResult> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length === 0) return { ok: false, error: "Give this device a name." };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, error: `Use a shorter name (up to ${MAX_NAME_LENGTH} characters).` };
  if (!(DEVICE_TYPES as readonly string[]).includes(input.deviceType)) return { ok: false, error: "Choose what kind of device this is." };
  if (!input.baseDomain) return { ok: false, error: "Printing from the print dialog is not set up yet. Ask your administrator." };

  const token = generateDeviceToken();
  const { data, error } = await supabase
    .from("member_devices")
    .insert({
      organization_id: input.organizationId,
      user_id: input.userId,
      name,
      device_type: input.deviceType,
      token_hash: hashDeviceToken(token),
    })
    .select(DEVICE_COLUMNS)
    .single();
  if (error || !data) return { ok: false, error: "Could not add this device. Try again." };

  return { ok: true, device: data as DeviceRow, token, hostname: deviceHostname(token, input.baseDomain) };
}

/**
 * Revokes a device (its address stops working). Scoped to the owner AND organization, so a member can only
 * revoke their own device even through the service-role client; an admin passes `asAdmin: true` to revoke any
 * device of the organization. Already-revoked devices keep their original revoked_at.
 */
export async function revokeDevice(
  supabase: Client,
  input: { deviceId: string; organizationId: string; userId: string; asAdmin?: boolean },
): Promise<{ ok: true } | { ok: false; error: string }> {
  let query = supabase
    .from("member_devices")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", input.deviceId)
    .eq("organization_id", input.organizationId)
    .is("revoked_at", null);
  if (!input.asAdmin) query = query.eq("user_id", input.userId);
  const { data, error } = await query.select("id");
  if (error) return { ok: false, error: "Could not turn this device off. Try again." };
  if (!data || data.length === 0) {
    // Either not theirs / not found, or already revoked. Make "already off" a success for the person who owns it.
    let existing = supabase
      .from("member_devices")
      .select("id, revoked_at")
      .eq("id", input.deviceId)
      .eq("organization_id", input.organizationId);
    if (!input.asAdmin) existing = existing.eq("user_id", input.userId);
    const { data: row } = await existing.maybeSingle();
    if (row && row.revoked_at) return { ok: true };
    return { ok: false, error: "Device not found." };
  }
  return { ok: true };
}

/**
 * Permanently deletes a device. Needs the service-role client (the browser roles have no DELETE grant on
 * member_devices), so the caller MUST have verified the signed-in user first. Scoped to the owner AND organization;
 * an admin passes `asAdmin: true` to delete any device of their own organization. device_events and device_issues
 * cascade; print_jobs.device_id is set null, so print history stays.
 */
export async function deleteDevice(
  supabase: Client,
  input: { deviceId: string; organizationId: string; userId: string; asAdmin?: boolean },
): Promise<{ ok: true } | { ok: false; error: string }> {
  let query = supabase.from("member_devices").delete().eq("id", input.deviceId).eq("organization_id", input.organizationId);
  if (!input.asAdmin) query = query.eq("user_id", input.userId);
  const { data, error } = await query.select("id");
  if (error) return { ok: false, error: "Could not delete this device. Try again." };
  if (!data || data.length === 0) return { ok: false, error: "Device not found." };
  return { ok: true };
}

/** A member's own devices, newest first. */
export async function listDevicesForMember(supabase: Client, input: { userId: string; organizationId: string }): Promise<DeviceRow[]> {
  const { data, error } = await supabase
    .from("member_devices")
    .select(DEVICE_COLUMNS)
    .eq("user_id", input.userId)
    .eq("organization_id", input.organizationId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load devices: ${error.message}`);
  return (data ?? []) as unknown as DeviceRow[];
}

/** Every device in an organization (admin view), newest first. */
export async function listDevicesForAdmin(supabase: Client, input: { organizationId: string }): Promise<DeviceRow[]> {
  const { data, error } = await supabase
    .from("member_devices")
    .select(DEVICE_COLUMNS)
    .eq("organization_id", input.organizationId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load devices: ${error.message}`);
  return (data ?? []) as unknown as DeviceRow[];
}

/**
 * Records a gateway event for a device: appends to device_events, bumps last_seen_at / last_user_agent, and sets
 * first_job_at on the first job_received. Needs the service role (device_events has no insert policy).
 * Best-effort bookkeeping: it returns false instead of throwing, so an event can never fail a print.
 */
export async function recordDeviceEvent(
  supabase: Client,
  input: { deviceId: string; type: DeviceEventType; userAgent?: string | null; detail?: Record<string, unknown> | null },
): Promise<boolean> {
  try {
    const nowIso = new Date().toISOString();
    const userAgent = input.userAgent ? input.userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null;

    const { error: insertError } = await supabase.from("device_events").insert({
      device_id: input.deviceId,
      type: input.type,
      user_agent: userAgent,
      detail: (input.detail ?? {}) as never,
    });
    if (insertError) return false;

    const { error: touchError } = await supabase
      .from("member_devices")
      .update({ last_seen_at: nowIso, ...(userAgent ? { last_user_agent: userAgent } : {}) })
      .eq("id", input.deviceId);
    if (touchError) return false;

    if (input.type === "job_received") {
      await supabase.from("member_devices").update({ first_job_at: nowIso }).eq("id", input.deviceId).is("first_job_at", null);
    }

    // Prune: anything older than the newest MAX_EVENTS_PER_DEVICE rows.
    const { data: stale } = await supabase
      .from("device_events")
      .select("id")
      .eq("device_id", input.deviceId)
      .order("created_at", { ascending: false })
      .range(MAX_EVENTS_PER_DEVICE, MAX_EVENTS_PER_DEVICE + 99);
    if (stale && stale.length > 0) {
      await supabase
        .from("device_events")
        .delete()
        .in(
          "id",
          stale.map((r) => r.id),
        );
    }
    return true;
  } catch {
    return false;
  }
}

export type IssueRow = Tables<"device_issues">;
export type EventRow = Tables<"device_events">;

/**
 * A member reports a problem with one of their own devices. Ownership is checked here (and again by RLS), and only
 * the columns the browser role may insert (device_id, kind, note) are sent.
 */
export async function reportIssue(
  supabase: Client,
  input: { deviceId: string; userId: string; organizationId: string; kind: string; note: string },
): Promise<{ ok: true } | { ok: false; error: string; field?: "kind" | "note" }> {
  const v = validateIssueInput({ kind: input.kind, note: input.note });
  if (!v.ok) return v;
  const { data: device } = await supabase
    .from("member_devices")
    .select("id")
    .eq("id", input.deviceId)
    .eq("user_id", input.userId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (!device) return { ok: false, error: "Device not found." };
  const { error } = await supabase.from("device_issues").insert({ device_id: input.deviceId, kind: v.kind, note: v.note });
  if (error) return { ok: false, error: "Could not send your report. Try again." };
  return { ok: true };
}

/** An org admin marks an open issue resolved. RLS limits the update to devices of the admin's organization. */
export async function resolveIssue(
  supabase: Client,
  input: { issueId: string; adminId: string; organizationId: string; note: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const v = validateResolveNote(input.note);
  if (!v.ok) return v;
  const { data, error } = await supabase
    .from("device_issues")
    .update({ status: "resolved", resolved_by: input.adminId, resolved_note: v.note, resolved_at: new Date().toISOString() })
    .eq("id", input.issueId)
    .eq("status", "open")
    .select("id");
  if (error) return { ok: false, error: "Could not save this. Try again." };
  if (!data || data.length === 0) return { ok: false, error: "This item is already resolved or no longer exists." };
  return { ok: true };
}

/** All issues (open and resolved) for the given devices, newest first. */
export async function listIssuesForDevices(supabase: Client, deviceIds: string[]): Promise<IssueRow[]> {
  if (deviceIds.length === 0) return [];
  const { data, error } = await supabase
    .from("device_issues")
    .select("*")
    .in("device_id", deviceIds)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load device issues: ${error.message}`);
  return (data ?? []) as IssueRow[];
}

/** The newest gateway events of one device (admin detail). */
export async function listEventsForDevice(supabase: Client, deviceId: string, limit = 30): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from("device_events")
    .select("*")
    .eq("device_id", deviceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not load device events: ${error.message}`);
  return (data ?? []) as EventRow[];
}
