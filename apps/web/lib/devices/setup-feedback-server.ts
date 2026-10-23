import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { listDevicesForMember, listIssuesForDevices } from "./devices";
import { feedbackCardDevices, summarizeSetups, validateFeedback, SETUP_KEYS, type FeedbackRow } from "./setup-feedback";

type Client = SupabaseClient<Database>;

export interface FeedbackCardDevice {
  id: string;
  name: string;
  device_type: string;
}

/** The member's devices we should ask "Did it come out OK?" about right now (usually none). Never throws: a failure just hides the card. */
export async function listFeedbackCardDevices(supabase: Client, input: { userId: string; organizationId: string }): Promise<FeedbackCardDevice[]> {
  try {
    const devices = (await listDevicesForMember(supabase, { userId: input.userId, organizationId: input.organizationId })).filter(
      (d) => !d.revoked_at && d.first_printed_at,
    );
    if (devices.length === 0) return [];
    const ids = devices.map((d) => d.id);
    const [{ data: answers, error: answersError }, issues, { data: failed }] = await Promise.all([
      supabase.from("device_setup_feedback").select("device_id").in("device_id", ids),
      listIssuesForDevices(supabase, ids),
      supabase.from("print_jobs").select("device_id").in("device_id", ids).eq("status", "failed"),
    ]);
    // Table missing (migration 0042 not applied yet) or unreadable: stay quiet rather than show a card that cannot save.
    if (answersError) return [];
    const openIssues = new Map<string, number>();
    for (const i of issues) if (i.status === "open") openIssues.set(i.device_id, (openIssues.get(i.device_id) ?? 0) + 1);
    const failedJobs = new Map<string, number>();
    for (const j of failed ?? []) if (j.device_id) failedJobs.set(j.device_id, (failedJobs.get(j.device_id) ?? 0) + 1);
    return feedbackCardDevices(devices, {
      answered: new Set((answers ?? []).map((a) => a.device_id)),
      openIssues,
      failedJobs,
      now: new Date(),
    }).map((d) => ({ id: d.id, name: d.name, device_type: d.device_type }));
  } catch {
    return [];
  }
}

/** Saves the member's answer. "Something was wrong" also opens a normal device problem so the existing admin flow sees it. */
export async function submitSetupFeedback(
  supabase: Client,
  input: { deviceId: string; userId: string; organizationId: string; outcome: string; note: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const v = validateFeedback({ outcome: input.outcome, note: input.note });
  if (!v.ok) return v;
  const { data: device } = await supabase
    .from("member_devices")
    .select("id")
    .eq("id", input.deviceId)
    .eq("user_id", input.userId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (!device) return { ok: false, error: "Device not found." };
  const { error } = await supabase.from("device_setup_feedback").insert({ device_id: input.deviceId, outcome: v.outcome, note: v.note });
  if (error) {
    return { ok: false, error: error.code === "23505" ? "You already answered this one. Thank you!" : "Could not save your answer. Try again." };
  }
  if (v.outcome === "problem") {
    // Best effort: the answer above is the record; this just makes the problem visible in the normal list too.
    await supabase.from("device_issues").insert({ device_id: input.deviceId, kind: "prints_wrong", note: v.note || "Said something was wrong after the first print." });
  }
  return { ok: true };
}

export async function loadSetupSummaries(supabase: Client, organizationId: string) {
  const [{ data: feedback }, { data: confirmations }] = await Promise.all([
    supabase.from("device_setup_feedback").select("setup_key, outcome, user_id, note, created_at").eq("organization_id", organizationId),
    supabase.from("setup_confirmations").select("setup_key").eq("organization_id", organizationId),
  ]);
  return summarizeSetups((feedback ?? []) as FeedbackRow[], confirmations ?? []);
}

/** An org admin marks one exact setup "Confirmed working" (or takes the mark off). RLS limits this to org admins of that org. */
export async function setSetupConfirmed(
  supabase: Client,
  input: { organizationId: string; adminId: string; setupKey: string; confirmed: boolean },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(SETUP_KEYS as readonly string[]).includes(input.setupKey)) return { ok: false, error: "Unknown setup." };
  if (input.confirmed) {
    const { error } = await supabase
      .from("setup_confirmations")
      .insert({ organization_id: input.organizationId, setup_key: input.setupKey, confirmed_by: input.adminId });
    if (error && error.code !== "23505") return { ok: false, error: "Could not save this. Try again." };
  } else {
    const { error } = await supabase.from("setup_confirmations").delete().eq("organization_id", input.organizationId).eq("setup_key", input.setupKey);
    if (error) return { ok: false, error: "Could not save this. Try again." };
  }
  await supabase.from("audit_logs").insert({
    organization_id: input.organizationId,
    actor_id: input.adminId,
    action: input.confirmed ? "setup.confirmed" : "setup.unconfirmed",
    target_type: "setup_confirmations",
    target_id: null,
    metadata: { setup_key: input.setupKey },
  });
  return { ok: true };
}
