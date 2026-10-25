import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { parseConnectionReport, summarizeConnectionTest, type ConnectionVerdict } from "./connection-test";

type Client = SupabaseClient<Database>;

const WINDOW_SECONDS = 60 * 60;
const MAX_PER_USER_PER_HOUR = 30;

/** Saves one connection-test result for the member's own device. `db` MUST be the service-role client (the table has no
 *  browser write access); who may write is decided here: the device must be this user's, in this organization. */
export async function saveConnectionTest(
  db: Client,
  input: { deviceId: string; userId: string; organizationId: string; report: unknown; userAgent: string | null },
): Promise<{ ok: true; verdict: ConnectionVerdict } | { ok: false; error: string }> {
  const report = parseConnectionReport(input.report);
  if (!report) return { ok: false, error: "That test result was not understood." };

  const { data: allowed, error: limitError } = await db.rpc("check_rate_limit", {
    p_key: `connection_test:user:${input.userId}`,
    p_max_count: MAX_PER_USER_PER_HOUR,
    p_window_seconds: WINDOW_SECONDS,
  });
  if (!limitError && allowed === false) return { ok: false, error: "Too many tests in a row. Wait a few minutes and try again." };

  const { data: device } = await db
    .from("member_devices")
    .select("id")
    .eq("id", input.deviceId)
    .eq("user_id", input.userId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (!device) return { ok: false, error: "Device not found." };

  const { verdict } = summarizeConnectionTest(report);
  const { error } = await db.from("device_connection_tests").insert({
    device_id: input.deviceId,
    organization_id: input.organizationId,
    user_id: input.userId,
    control_ok: report.control.ok,
    control_ms: report.control.ms,
    probe_ok: report.probe.ok,
    probe_ms: report.probe.ms,
    real_ok: report.real.ok,
    real_ms: report.real.ms,
    verdict,
    user_agent: input.userAgent ? input.userAgent.slice(0, 300) : null,
  });
  if (error) return { ok: false, error: "Could not save the test result." };
  return { ok: true, verdict };
}

export interface LatestConnectionTest {
  deviceId: string;
  verdict: ConnectionVerdict;
  createdAt: string;
}

/** The newest result per device (RLS decides what the caller may see). Never throws: a missing table just shows nothing. */
export async function latestConnectionTests(supabase: Client, deviceIds: string[]): Promise<Map<string, LatestConnectionTest>> {
  const out = new Map<string, LatestConnectionTest>();
  if (deviceIds.length === 0) return out;
  try {
    const { data, error } = await supabase
      .from("device_connection_tests")
      .select("device_id, verdict, created_at")
      .in("device_id", deviceIds)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) return out;
    for (const r of data ?? []) {
      if (!out.has(r.device_id)) out.set(r.device_id, { deviceId: r.device_id, verdict: r.verdict as ConnectionVerdict, createdAt: r.created_at });
    }
  } catch {
    // table not there yet: quiet
  }
  return out;
}
