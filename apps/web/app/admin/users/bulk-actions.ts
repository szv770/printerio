"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { describeDatabaseError } from "@/lib/action-errors";
import { routes } from "@/lib/routes";
import { cancelMemberQueue } from "@/lib/jobs/lifecycle";
import { ensureMemberUserCode } from "@/lib/jobs/ensure-user-code";
import { ensureMemberUserCodes, findMembersWithoutCode } from "@/lib/jobs/ensure-user-codes";
import { logger } from "@/lib/logger";
import {
  BULK_CHUNK,
  bulkAuditRow,
  bulkResultMessage,
  chunk,
  normalizeBulkIds,
  parseBulkOp,
  planBulkChange,
  type BulkMemberRow,
  type BulkOp,
  type BulkResult,
} from "@/lib/admin/bulk-members";
import { fetchSections } from "@/lib/admin/people-list";
import { removeFromOrgGroups } from "@/lib/admin/groups-list";
import { loadPersonDetail, type PersonDetail } from "@/lib/admin/person-detail";

/** Bulk changes to people. Admin only. The organization comes from the session; the ids come from the browser and are
 *  never trusted: every one is looked up with organization_id in the query, and if any is not found nothing is changed
 *  (see lib/admin/bulk-members.ts for every guard). One audit row per action, however many people it covers. */
export async function bulkUpdateMembersAction(input: unknown): Promise<BulkResult> {
  const session = await requireOrgRole(["org_admin"]);
  const orgId = session.membership.organization_id;
  const raw = (input ?? {}) as Record<string, unknown>;

  const ids = normalizeBulkIds(raw.ids);
  if (!ids.ok) return { ok: false, message: ids.error };
  const parsedOp = parseBulkOp(raw.op);
  if (!parsedOp.ok) return { ok: false, message: parsedOp.error };
  const op: BulkOp = parsedOp.op;
  // The page shows "N people" and the admin confirms that number; the server refuses if the list it got is a different size.
  if (raw.confirmCount !== ids.ids.length) return { ok: false, message: "The selection changed. Check the number and try again." };

  const supabase = await createClient();

  const found: BulkMemberRow[] = [];
  for (const part of chunk(ids.ids, BULK_CHUNK)) {
    const { data, error } = await supabase
      .from("organization_members")
      .select("user_id, role, status, department")
      .eq("organization_id", orgId)
      .in("user_id", part);
    if (error) return { ok: false, message: describeDatabaseError(error, "Couldn't look those people up.") };
    for (const r of data ?? []) found.push({ userId: r.user_id, role: r.role, status: r.status, department: r.department });
  }

  const { count: adminCount } = await supabase
    .from("organization_members")
    .select("user_id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("role", "org_admin")
    .eq("status", "active");

  const plan = planBulkChange({ actorId: session.userId, op, requestedIds: ids.ids, found, activeAdminCount: adminCount ?? 0 });
  if (!plan.ok) return { ok: false, message: plan.error, needsConfirm: plan.needsConfirm };
  if (plan.changing.length === 0) return { ok: true, changed: 0, message: bulkResultMessage(op, 0, plan.unchanged) };

  // Apply in chunks. Every statement repeats the organization filter, so even a bug above cannot reach another organization.
  const changed: string[] = [];
  let failed = 0;
  let firstError: string | null = null;
  for (const part of chunk(plan.changing, BULK_CHUNK)) {
    let error: { message: string } | null;
    if (op.type === "remove") {
      ({ error } = await supabase.from("organization_members").delete().eq("organization_id", orgId).in("user_id", part));
    } else {
      const patch = op.type === "role" ? { role: op.role } : op.type === "section" ? { department: op.section } : { status: op.status };
      ({ error } = await supabase.from("organization_members").update(patch).eq("organization_id", orgId).in("user_id", part));
    }
    if (error) {
      failed += part.length;
      firstError ??= describeDatabaseError(error, "Couldn't save part of that change.");
    } else {
      changed.push(...part);
    }
  }

  // People who were switched off or removed should not keep printing from their waiting jobs (best effort, a few at a time).
  if (op.type === "remove" && changed.length > 0) {
    for (const part of chunk(changed, BULK_CHUNK)) await removeFromOrgGroups(supabase, orgId, part);
  }
  if (op.type === "remove" || (op.type === "status" && op.status === "disabled")) {
    for (const part of chunk(changed, 5)) await Promise.all(part.map((userId) => stopTheirQueue(orgId, session.userId, userId)));
  }

  if (changed.length > 0) {
    await supabase.from("audit_logs").insert(bulkAuditRow({ organizationId: orgId, actorId: session.userId, op, changedIds: changed, unchanged: plan.unchanged, failed }));
  }

  revalidatePath(routes.adminUsers);
  revalidatePath(routes.adminGroups);
  if (failed > 0) {
    return {
      ok: false,
      changed: changed.length,
      message: `${firstError ?? "Couldn't save part of that change."} ${changed.length.toLocaleString("en-US")} of ${plan.changing.length.toLocaleString("en-US")} people were changed; the rest were not. Refresh and try again for the rest.`,
    };
  }
  return { ok: true, changed: changed.length, message: bulkResultMessage(op, changed.length, plan.unchanged) };
}

async function stopTheirQueue(organizationId: string, adminId: string, userId: string): Promise<void> {
  try {
    await cancelMemberQueue(createServiceRoleClient(), { organizationId, adminId, userId });
  } catch (err) {
    logger.error("could not stop a bulk-changed member's waiting jobs", { userId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The sections already in use (the pick-list). Admins and approvers can see the People list, so both can ask. */
export async function listSectionsAction(): Promise<string[]> {
  const session = await requireOrgRole(["org_admin", "approver"]);
  try {
    return await fetchSections(await createClient(), session.membership.organization_id);
  } catch (err) {
    logger.error("could not list sections", { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/** Everything the person drawer shows, for one person of the viewer's own organization (null = not found). */
export async function loadPersonDetailAction(userId: unknown): Promise<PersonDetail | null> {
  const session = await requireOrgRole(["org_admin", "approver"]);
  if (typeof userId !== "string" || !/^[\w-]{1,64}$/.test(userId)) return null;
  return loadPersonDetail(await createClient(), {
    organizationId: session.membership.organization_id,
    userId,
    isOrgAdmin: session.membership.role === "org_admin",
  });
}

export interface AssignCodesResult {
  ok: boolean;
  message: string;
  /** People who still have no code after this batch. */
  remaining?: number;
}

/** Gives print codes to people who have none, one batch (200) at a time. Replaces the writes that used to happen every
 *  time the Users page was opened. Admin only; service role only after that check; scoped to the admin's organization. */
export async function assignMissingCodesAction(): Promise<AssignCodesResult> {
  const session = await requireOrgRole(["org_admin"]);
  const orgId = session.membership.organization_id;
  const writer = createServiceRoleClient();
  try {
    const members = await findMembersWithoutCode(writer, orgId);
    if (members.length === 0) return { ok: true, message: "Everyone already has a print code.", remaining: 0 };
    const { assigned, failed } = await ensureMemberUserCodes(writer, { organizationId: orgId, members });
    const { count } = await writer.from("organization_members").select("user_id", { count: "exact", head: true }).eq("organization_id", orgId).is("user_code", null);
    if (assigned > 0) {
      await (await createClient()).from("audit_logs").insert({
        organization_id: orgId,
        actor_id: session.userId,
        action: "members.print_codes_assigned",
        target_type: "organization_members",
        target_id: null,
        metadata: { count: assigned, failed },
      });
    }
    revalidatePath(routes.adminUsers);
    const left = count ?? 0;
    const failNote = failed > 0 ? ` ${failed} could not be given one.` : "";
    return {
      ok: failed === 0,
      remaining: left,
      message: `Gave ${assigned.toLocaleString("en-US")} ${assigned === 1 ? "person" : "people"} a print code.${failNote}${left > 0 ? ` ${left.toLocaleString("en-US")} still have none: press again.` : ""}`,
    };
  } catch (err) {
    logger.error("could not assign print codes", { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, message: "Could not give out print codes right now. Try again in a moment." };
  }
}

/** Gives ONE person their print code now (from the drawer). Same guarded write as the print path. */
export async function assignMemberCodeAction(userId: unknown): Promise<{ ok: boolean; message: string; code?: string }> {
  const session = await requireOrgRole(["org_admin"]);
  if (typeof userId !== "string" || !/^[\w-]{1,64}$/.test(userId)) return { ok: false, message: "Choose a person." };
  const orgId = session.membership.organization_id;
  const supabase = await createClient();
  // Look the person up with the organization filter first: the service-role write below must never run for someone else's member.
  const { data: member } = await supabase
    .from("organization_members")
    .select("user_id, user_code, profiles(email, display_name)")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!member) return { ok: false, message: "That person is no longer in this organization." };
  try {
    const code = await ensureMemberUserCode(createServiceRoleClient(), {
      organizationId: orgId,
      userId,
      displayName: member.profiles?.display_name ?? null,
      email: member.profiles?.email ?? null,
      stored: member.user_code,
    });
    if (!member.user_code) {
      await supabase.from("audit_logs").insert({
        organization_id: orgId,
        actor_id: session.userId,
        action: "member.print_code_changed",
        target_type: "organization_members",
        target_id: userId,
        metadata: { print_code: code, assigned_automatically: true },
      });
    }
    revalidatePath(routes.adminUsers);
    return { ok: true, message: "Print code assigned.", code };
  } catch (err) {
    logger.error("could not assign a print code", { userId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, message: "Could not assign a code right now. Try again in a moment." };
  }
}
