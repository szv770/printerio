/**
 * Pure helpers for the org's "Who can join" setting (security review F4).
 * The enforcement is in Postgres (public.join_org_by_domain(), migration 0039);
 * this module mirrors its matching rule for tests/UI and validates the admin form.
 */
import { isValidDomain, normalizeDomainInput } from "@/lib/auth/domains";

export const JOIN_MODES = ["invite_only", "invite_or_domain"] as const;
export type JoinMode = (typeof JOIN_MODES)[number];
export const DOMAIN_JOIN_ROLES = ["student", "staff"] as const;
export type DomainJoinRole = (typeof DOMAIN_JOIN_ROLES)[number];

export function isJoinMode(value: unknown): value is JoinMode {
  return typeof value === "string" && (JOIN_MODES as readonly string[]).includes(value);
}
export function isDomainJoinRole(value: unknown): value is DomainJoinRole {
  return typeof value === "string" && (DOMAIN_JOIN_ROLES as readonly string[]).includes(value);
}

/** Exact, case-insensitive domain match on a single-@ address. No suffix or subdomain matching. */
export function emailMatchesAllowedDomains(email: string, domains: readonly string[]): boolean {
  const m = /^[^@\s]+@([^@\s]+)$/.exec(email.trim().toLowerCase());
  if (!m) return false;
  return domains.some((d) => d.toLowerCase() === m[1]);
}

export type JoinSettingsResult =
  | { ok: true; mode: JoinMode; domains: string[] }
  | { ok: false; error: string };

/** Validates the admin form. Stricter than the old list: a pasted email address is rejected, not silently trimmed to its domain. */
export function validateJoinSettings(input: { mode: string; domainsInput: string }): JoinSettingsResult {
  if (!isJoinMode(input.mode)) return { ok: false, error: "Choose who can join." };
  const seen = new Set<string>();
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const part of input.domainsInput.split(/[,\n]/)) {
    const raw = part.trim();
    if (!raw) continue;
    const looksLikeEmailOrUrl = /^[^@]+@/.test(raw) || raw.includes("://") || /[/?#\s]/.test(raw);
    const normalized = normalizeDomainInput(raw);
    if (looksLikeEmailOrUrl || !isValidDomain(normalized)) {
      invalid.push(raw);
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      domains.push(normalized);
    }
  }
  if (invalid.length > 0) {
    return { ok: false, error: `Enter just the domain, like "lecfl.com", not an email address or web link. Couldn't use: ${invalid.join(", ")}` };
  }
  if (input.mode === "invite_or_domain" && domains.length === 0) {
    return { ok: false, error: "Add at least one email domain, or choose \"Invitation only\"." };
  }
  return { ok: true, mode: input.mode, domains };
}
