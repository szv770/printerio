/**
 * Pure logic for the unified Admin > Settings form: which server action each
 * field belongs to, the FormData each action expects, which section each action
 * lives in, and the one-line summaries shown while a section is closed.
 * No I/O, so it is unit tested on its own (settings-form.test.ts).
 */
import { parseAllowedDomainsInput } from "@/lib/auth/domains";
import { STAMP_SHOW_OPTIONS, STAMP_STRENGTH_OPTIONS } from "@/lib/jobs/user-code";
import { dirtyKeys } from "@/lib/ui/dirty";

export interface SettingsValues extends Record<string, unknown> {
  domains: string;
  joinMode: "invite_only" | "invite_or_domain";
  domainJoinRole: "student" | "staff";
  bindingSide: "left" | "right";
  adminsBypass: boolean;
  autoRetry: boolean;
  stampEnabled: boolean;
  stampShow: string;
  stampStrength: string;
}

/** One entry per existing server action in app/admin/settings/actions.ts. */
export type SettingsActionId = "domains" | "bindingSide" | "adminBypass" | "autoRetry" | "stamp";
export type SettingsSectionId = "signin" | "printing" | "stamp" | "admins";

export const ACTION_FIELDS: Record<SettingsActionId, Array<keyof SettingsValues>> = {
  // "Who can join": the mode, the domain list and the role are validated and saved together (one UPDATE),
  // because the database refuses domain mode with an empty list.
  domains: ["domains", "joinMode", "domainJoinRole"],
  bindingSide: ["bindingSide"],
  adminBypass: ["adminsBypass"],
  autoRetry: ["autoRetry"],
  stamp: ["stampEnabled", "stampShow", "stampStrength"],
};

export const ACTION_SECTION: Record<SettingsActionId, SettingsSectionId> = {
  domains: "signin",
  bindingSide: "printing",
  autoRetry: "printing",
  stamp: "stamp",
  adminBypass: "admins",
};

/** Fixed order the unified Save runs the actions in. */
export const ACTION_ORDER: SettingsActionId[] = ["domains", "bindingSide", "autoRetry", "adminBypass", "stamp"];

/** Actions that have at least one changed field, in save order. */
export function dirtyActions(initial: SettingsValues, current: SettingsValues): SettingsActionId[] {
  const changed = new Set<keyof SettingsValues>(dirtyKeys(initial, current));
  return ACTION_ORDER.filter((a) => ACTION_FIELDS[a].some((f) => changed.has(f)));
}

/** The exact form fields each existing action reads. A checked checkbox
 *  submits "on"; an unchecked one submits nothing (matches the old forms). */
export function actionFormFields(action: SettingsActionId, v: SettingsValues): Record<string, string> {
  switch (action) {
    case "domains":
      return { domains: v.domains, joinMode: v.joinMode, domainJoinRole: v.domainJoinRole };
    case "bindingSide":
      return { defaultBookletBindingSide: v.bindingSide };
    case "adminBypass":
      return v.adminsBypass ? { adminsBypassRestrictions: "on" } : {};
    case "autoRetry":
      return v.autoRetry ? { autoRetryFailedPrints: "on" } : {};
    case "stamp":
      return { ...(v.stampEnabled ? { stampEnabled: "on" } : {}), stampShow: v.stampShow, stampStrength: v.stampStrength };
  }
}

/** Sections that contain a failed action (they open themselves to show it). */
export function sectionsWithErrors(errors: Partial<Record<SettingsActionId, string>>): Set<SettingsSectionId> {
  const out = new Set<SettingsSectionId>();
  for (const [action, msg] of Object.entries(errors)) if (msg) out.add(ACTION_SECTION[action as SettingsActionId]);
  return out;
}

// ---- closed-section summaries ------------------------------------------------

export function signInSummary(v: Pick<SettingsValues, "domains" | "joinMode">): string {
  const { domains } = parseAllowedDomainsInput(v.domains);
  if (v.joinMode !== "invite_or_domain") {
    return domains.length === 0 ? "Invitation only (add a domain to let school emails join)" : "Invitation only";
  }
  if (domains.length === 0) return "Invitation only (add a domain to let school emails join)";
  const shown = domains.slice(0, 2).join(", ");
  const more = domains.length > 2 ? ` and ${domains.length - 2} more` : "";
  return `Invitation, or an email at ${shown}${more}`;
}

export function printingSummary(v: Pick<SettingsValues, "bindingSide" | "autoRetry">): string {
  return `Booklets bind on the ${v.bindingSide === "right" ? "right" : "left"}. Failed prints retry: ${v.autoRetry ? "on" : "off"}`;
}

export function stampSummary(v: Pick<SettingsValues, "stampEnabled" | "stampShow" | "stampStrength">): string {
  if (!v.stampEnabled) return "Print stamp: off";
  const show = STAMP_SHOW_OPTIONS.find((o) => o.value === v.stampShow)?.label.toLowerCase() ?? v.stampShow;
  const strength = STAMP_STRENGTH_OPTIONS.find((o) => o.value === v.stampStrength)?.value ?? v.stampStrength;
  return `Print stamp: on, ${strength} (${show})`;
}

export function adminsSummary(v: Pick<SettingsValues, "adminsBypass">): string {
  return v.adminsBypass ? "Admins skip approval and limits on their own prints" : "Admins follow the same rules as everyone else";
}
