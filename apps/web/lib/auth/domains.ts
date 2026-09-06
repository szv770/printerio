/**
 * Pure helpers for `organizations.allowed_domains` - parsing/validating the
 * org_admin-facing settings form (app/admin/settings) and reading a domain
 * back out of an email address. The actual sign-in gate is enforced in
 * Postgres (`email_domain_allowed()`, supabase/migrations/0013_*.sql), not
 * here - this module only prevents an org_admin from saving garbage into the
 * column (a full email, a URL, stray whitespace) that would never match
 * anything.
 */

// Bare-domain shape: labels of letters/digits/hyphens (no leading/trailing
// hyphen), at least one dot, ASCII only - deliberately conservative rather
// than fully RFC-3986-correct, since this only needs to reject obvious junk
// ("bob@school.org", "https://school.org/path", "school .org"), not validate
// every real-world domain edge case.
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Lowercases/trims and strips an "@" prefix or a "scheme://" + path a user
 *  might paste by habit, so "https://LECFL.com/" and "lecfl.com" both end up
 *  as "lecfl.com" - it does NOT make an invalid string valid. */
export function normalizeDomainInput(raw: string): string {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip "scheme://"
  value = value.replace(/^@/, "");
  value = value.split(/[/?#]/, 1)[0]!; // drop any path/query/hash
  value = value.split("@").pop()!; // "user@domain" -> "domain"
  return value;
}

export function isValidDomain(domain: string): boolean {
  return DOMAIN_PATTERN.test(domain);
}

export interface ParsedAllowedDomains {
  domains: string[];
  invalid: string[];
}

/** Splits a comma-and/or-newline-separated textarea value into a deduplicated
 *  list of bare domains, reporting anything that didn't come out looking like
 *  a bare domain so the caller can reject the whole submission with a
 *  specific message instead of silently dropping entries. */
export function parseAllowedDomainsInput(raw: string): ParsedAllowedDomains {
  const seen = new Set<string>();
  const domains: string[] = [];
  const invalid: string[] = [];

  for (const part of raw.split(/[,\n]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const normalized = normalizeDomainInput(trimmed);
    if (!isValidDomain(normalized)) {
      invalid.push(trimmed);
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      domains.push(normalized);
    }
  }

  return { domains, invalid };
}

/** "user@school.org" -> "school.org"; "" for anything without an "@". */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).trim().toLowerCase();
}
