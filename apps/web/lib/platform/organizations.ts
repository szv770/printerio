/**
 * Pure helpers for the /platform "Create organization" form
 * (app/platform/organizations/new). Mirrors the shape lib/auth/bootstrap.ts
 * already uses for the single-org bootstrap path (slug derived from name,
 * same character set), kept as its own small pure module here rather than
 * exported from bootstrap.ts - that file is intentionally left alone (see
 * its own header comment: single-org bootstrap is a separate, one-shot code
 * path) and this one needs its own validation message for a form field a
 * human types into directly, which the bootstrap path never exposes.
 */

// Matches organizations.slug's check constraint exactly
// (supabase/migrations/0001_core_tables.sql) - keep these in sync by hand.
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$/;

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 100 && SLUG_PATTERN.test(slug);
}

/** Best-effort slug derived from an organization name - lowercase, hyphenated,
 *  ASCII alphanumerics only. Does not guarantee uniqueness (the database's
 *  unique constraint on organizations.slug is the actual enforcement point);
 *  callers should surface that constraint violation as a distinct error
 *  message rather than silently disambiguating. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export interface OrganizationNameAndSlug {
  name: string;
  slug: string;
}

export type OrganizationInputError = { field: "name" | "slug"; message: string };

/** Validates the raw form fields, filling in a slug from `name` when the
 *  admin left the slug field blank. Returns either the cleaned values or the
 *  first validation problem found - never both. */
export function parseOrganizationInput(rawName: string, rawSlug: string): OrganizationInputError | OrganizationNameAndSlug {
  const name = rawName.trim();
  if (name.length < 1 || name.length > 200) {
    return { field: "name", message: "Enter a name between 1 and 200 characters." };
  }

  const explicitSlug = rawSlug.trim().toLowerCase();
  const slug = explicitSlug || slugify(name);
  if (!isValidSlug(slug)) {
    return {
      field: "slug",
      message:
        "Slug must be lowercase letters, numbers, and hyphens only (no leading/trailing hyphen), 1-100 characters.",
    };
  }

  return { name, slug };
}
