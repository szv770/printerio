/**
 * Bulk changes to people (role, section, on/off, remove): the rules, with no I/O so every guard is unit tested
 * (bulk-members.test.ts). The server action (app/admin/users/bulk-actions.ts) loads the people, asks `planBulkChange`
 * what may happen, applies it in chunks and writes ONE audit row built by `bulkAuditRow`.
 *
 * Rules, in the order they are checked:
 *  1. The list of ids is clean, not empty, and at most BULK_MAX_IDS long.
 *  2. Every id must be a member of the admin's own organization. The server loads them with organization_id in the query;
 *     if any asked-for id was not found the whole request is refused (a stale list or a tampered one: nothing is changed).
 *  3. You cannot switch yourself off, remove yourself or take your own admin role away in bulk (do it from your own page).
 *  4. The organization must keep at least one active admin.
 *  5. Giving a lot of people approver/admin rights needs a confirm, and at most BULK_PRIVILEGED_ROLE_MAX at a time.
 *
 * EXTENSION POINTS: `BulkTarget` is the one place that says WHO a bulk action applies to. Today it is a list of ids from the
 * page. "Everyone matching this filter", "everyone in group X" and "everyone from the directory sync" are more variants
 * here that the server resolves to ids (in chunks, re-checking the organization) before calling planBulkChange.
 */
import type { OrgRole } from "@printio/shared";
import { assertCanDisableSelf } from "@/lib/member-safety";

export const BULK_MAX_IDS = 200;
/** A chunk of ids per database statement (keeps URLs short). */
export const BULK_CHUNK = 100;
export const BULK_PRIVILEGED_ROLE_MAX = 25;
export const MAX_SECTION_LENGTH = 80;

export type BulkTarget = { kind: "ids"; ids: string[] };
// Later: | { kind: "filter"; filter: PeopleFilter } | { kind: "group"; groupId: string } | { kind: "source"; source: MemberSource }

export type BulkOp =
  | { type: "role"; role: OrgRole; confirmPrivileged?: boolean }
  | { type: "section"; section: string | null }
  | { type: "status"; status: "active" | "disabled" }
  | { type: "remove" };

export interface BulkMemberRow {
  userId: string;
  role: string;
  status: string;
  department: string | null;
}

export type BulkPlan =
  | { ok: true; ids: string[]; changing: string[]; unchanged: number; lostAdmins: number }
  | { ok: false; error: string; needsConfirm?: "privileged_role" };

const ROLES: OrgRole[] = ["org_admin", "approver", "staff", "student"];
const ID_SAFE = /^[\w-]{1,64}$/;

/** Clean, de-duplicated ids or an error. Never trusts the client: anything that is not a plain id string is refused. */
export function normalizeBulkIds(input: unknown): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "Choose the people first." };
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const v of input) {
    if (typeof v !== "string" || !ID_SAFE.test(v)) return { ok: false, error: "That selection is not valid. Refresh the page and try again." };
    if (!seen.has(v)) {
      seen.add(v);
      ids.push(v);
    }
  }
  if (ids.length === 0) return { ok: false, error: "Choose the people first." };
  if (ids.length > BULK_MAX_IDS) return { ok: false, error: `Choose at most ${BULK_MAX_IDS} people at a time.` };
  return { ok: true, ids };
}

/** A section typed or picked by the admin -> what is stored (null = none). */
export function normalizeSection(raw: unknown): { ok: true; section: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, section: null };
  if (typeof raw !== "string") return { ok: false, error: "That section is not valid." };
  const t = raw.trim();
  if (t.length > MAX_SECTION_LENGTH) return { ok: false, error: `A section name can be at most ${MAX_SECTION_LENGTH} characters.` };
  return { ok: true, section: t || null };
}

/** Reads an untrusted object into a BulkOp (or an error). */
export function parseBulkOp(raw: unknown): { ok: true; op: BulkOp } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Choose what to do." };
  const o = raw as Record<string, unknown>;
  switch (o.type) {
    case "role":
      if (typeof o.role !== "string" || !ROLES.includes(o.role as OrgRole)) return { ok: false, error: "Invalid role." };
      return { ok: true, op: { type: "role", role: o.role as OrgRole, confirmPrivileged: o.confirmPrivileged === true } };
    case "section": {
      const s = normalizeSection(o.section);
      return s.ok ? { ok: true, op: { type: "section", section: s.section } } : s;
    }
    case "status":
      if (o.status !== "active" && o.status !== "disabled") return { ok: false, error: "Invalid status." };
      return { ok: true, op: { type: "status", status: o.status } };
    case "remove":
      return { ok: true, op: { type: "remove" } };
    default:
      return { ok: false, error: "Choose what to do." };
  }
}

const isActiveAdmin = (m: BulkMemberRow) => m.role === "org_admin" && m.status === "active";

/** Decides what a bulk change may do. `found` = the requested ids that exist in the admin's organization (and only those). */
export function planBulkChange(input: {
  actorId: string;
  op: BulkOp;
  requestedIds: string[];
  found: BulkMemberRow[];
  activeAdminCount: number;
}): BulkPlan {
  const { actorId, op, requestedIds, found, activeAdminCount } = input;
  const byId = new Map(found.map((m) => [m.userId, m]));
  if (requestedIds.some((id) => !byId.has(id))) {
    return { ok: false, error: "Some of the chosen people are no longer in this organization. Refresh the list and try again. Nothing was changed." };
  }
  const targets = requestedIds.map((id) => byId.get(id)!);
  const includesSelf = requestedIds.includes(actorId);

  let changing: BulkMemberRow[];
  let losing: BulkMemberRow[] = [];
  switch (op.type) {
    case "role": {
      changing = targets.filter((m) => m.role !== op.role);
      losing = changing.filter((m) => isActiveAdmin(m) && op.role !== "org_admin");
      if (losing.some((m) => m.userId === actorId)) {
        return { ok: false, error: "You can't take away your own admin role in bulk. Change it from your own page, or ask another admin." };
      }
      const privileged = op.role === "org_admin" || op.role === "approver";
      if (privileged && changing.length > 0) {
        if (changing.length > BULK_PRIVILEGED_ROLE_MAX) {
          return { ok: false, error: `You can give the ${op.role === "org_admin" ? "Admin" : "Approver"} role to at most ${BULK_PRIVILEGED_ROLE_MAX} people at a time.` };
        }
        if (!op.confirmPrivileged) {
          return {
            ok: false,
            needsConfirm: "privileged_role",
            error: `${op.role === "org_admin" ? "Admins" : "Approvers"} can see more and change more. Confirm that you want to give this role to ${changing.length} ${changing.length === 1 ? "person" : "people"}.`,
          };
        }
      }
      break;
    }
    case "section":
      changing = targets.filter((m) => (m.department ?? null) !== op.section);
      break;
    case "status": {
      changing = targets.filter((m) => m.status !== op.status);
      if (op.status === "disabled") {
        const selfError = includesSelf ? assertCanDisableSelf(actorId, actorId) : null;
        if (selfError) return { ok: false, error: selfError };
        losing = changing.filter(isActiveAdmin);
      }
      break;
    }
    case "remove":
      if (includesSelf) return { ok: false, error: "You can't remove yourself in bulk. Ask another admin to do it." };
      changing = targets;
      losing = changing.filter(isActiveAdmin);
      break;
  }

  if (losing.length > 0 && activeAdminCount - losing.length < 1) {
    return { ok: false, error: "This would leave the organization with no active admin. Keep at least one admin, then try again." };
  }
  return {
    ok: true,
    ids: requestedIds,
    changing: changing.map((m) => m.userId),
    unchanged: targets.length - changing.length,
    lostAdmins: losing.length,
  };
}

const AUDIT_ACTION: Record<BulkOp["type"], string> = {
  role: "members.bulk_role_changed",
  section: "members.bulk_section_changed",
  status: "members.bulk_status_changed",
  remove: "members.bulk_removed",
};

export const AUDIT_SAMPLE_SIZE = 10;

/** The ONE audit row for a bulk action: what was done, how many people it changed, and a sample of who. */
export function bulkAuditRow(input: { organizationId: string; actorId: string; op: BulkOp; changedIds: string[]; unchanged: number; failed?: number }) {
  const patch =
    input.op.type === "role"
      ? { role: input.op.role }
      : input.op.type === "section"
        ? { section: input.op.section }
        : input.op.type === "status"
          ? { status: input.op.status }
          : {};
  return {
    organization_id: input.organizationId,
    actor_id: input.actorId,
    action: AUDIT_ACTION[input.op.type],
    target_type: "organization_members",
    target_id: null,
    metadata: {
      count: input.changedIds.length,
      unchanged: input.unchanged,
      ...(input.failed ? { failed: input.failed } : {}),
      ...patch,
      sample_ids: input.changedIds.slice(0, AUDIT_SAMPLE_SIZE),
    },
  };
}

/** Splits a list into chunks (for `.in()` and for concurrency). */
export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** The plain-English answer shown after a bulk action. */
export function bulkResultMessage(op: BulkOp, changed: number, unchanged: number): string {
  const who = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "person" : "people"}`;
  const tail = unchanged > 0 ? ` ${who(unchanged)} already had it.` : "";
  switch (op.type) {
    case "role":
      return `Changed the role for ${who(changed)}.${tail}`;
    case "section":
      return op.section ? `Moved ${who(changed)} to section ${op.section}.${tail}` : `Cleared the section for ${who(changed)}.${tail}`;
    case "status":
      return op.status === "disabled" ? `Switched off ${who(changed)}.${tail}` : `Switched on ${who(changed)}.${tail}`;
    case "remove":
      return `Removed ${who(changed)}. Their accounts still exist.`;
  }
}

/** What a bulk action tells the page. */
export interface BulkResult {
  ok: boolean;
  /** Plain-English line for the page (success or the reason nothing happened). */
  message: string;
  changed?: number;
  /** The server wants an extra confirm before it will do this (the page asks, then sends again with the confirm). */
  needsConfirm?: "privileged_role";
}
