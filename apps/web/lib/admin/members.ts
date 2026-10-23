/**
 * Pure logic for the Users page: what changed on each member row, which
 * existing server action saves each change and with which form fields, and the
 * search / filter box. No I/O, unit tested in members.test.ts.
 */
import { roleLabel } from "@/lib/role-label";

export interface MemberDraft {
  role: string;
  department: string;
  /** What the admin typed in the print code box (empty = automatic). */
  userCode: string;
  status: string;
}

/** One entry per existing server action in app/admin/users/actions.ts. */
export type MemberActionId = "role" | "department" | "userCode" | "status";

/** Fixed order a member's changes are saved in. */
export const MEMBER_ACTION_ORDER: MemberActionId[] = ["role", "department", "userCode", "status"];

function same(action: MemberActionId, a: string, b: string): boolean {
  if (action === "userCode") return a.trim().toUpperCase() === b.trim().toUpperCase();
  if (action === "role" || action === "status") return a === b;
  return a.trim() === b.trim();
}

/** The actions that have a change on this member, in save order. */
export function memberChangeActions(baseline: MemberDraft, draft: MemberDraft): MemberActionId[] {
  return MEMBER_ACTION_ORDER.filter((a) => !same(a, baseline[a], draft[a]));
}

/** Members with at least one change (only those that have a draft). */
export function changedMembers(
  baselines: Record<string, MemberDraft>,
  drafts: Record<string, MemberDraft>,
): Array<{ userId: string; actions: MemberActionId[] }> {
  const out: Array<{ userId: string; actions: MemberActionId[] }> = [];
  for (const userId of Object.keys(baselines)) {
    const draft = drafts[userId];
    if (!draft) continue;
    const actions = memberChangeActions(baselines[userId]!, draft);
    if (actions.length > 0) out.push({ userId, actions });
  }
  return out;
}

/** Exactly the form fields each existing action reads. */
export function memberActionFields(action: MemberActionId, userId: string, d: MemberDraft): Record<string, string> {
  switch (action) {
    case "role":
      return { userId, role: d.role };
    case "department":
      return { userId, department: d.department.trim() };
    case "userCode":
      return { userId, userCode: d.userCode.trim() };
    case "status":
      return { userId, status: d.status };
  }
}

export interface MemberListItem {
  userId: string;
  displayName: string | null;
  email: string;
  role: string;
  status: string;
  department: string | null;
  /** The print code shown (stored or automatic). */
  code: string;
}

export function filterMembers(
  members: MemberListItem[],
  f: { query: string; role?: string; status?: string },
): MemberListItem[] {
  const q = f.query.trim().toLowerCase();
  return members.filter((m) => {
    if (f.role && m.role !== f.role) return false;
    if (f.status && m.status !== f.status) return false;
    if (!q) return true;
    return [m.displayName, m.email, m.department, m.code].some((v) => (v ?? "").toLowerCase().includes(q));
  });
}

/** The four roles, in the order they are offered, with their on-screen names. */
export function roleChoices(): Array<{ value: string; label: string }> {
  return ["student", "staff", "approver", "org_admin"].map((value) => ({ value, label: roleLabel(value) }));
}
