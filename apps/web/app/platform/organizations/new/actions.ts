"use server";

import { revalidatePath } from "next/cache";
import { requirePlatformRole } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { describeDatabaseError } from "@/lib/action-errors";
import { parseAllowedDomainsInput } from "@/lib/auth/domains";
import { parseOrganizationInput } from "@/lib/platform/organizations";
import { routes } from "@/lib/routes";

export interface CreateOrganizationActionState {
  error?: string;
  success?: string;
}
const initial: CreateOrganizationActionState = {};
export { initial as initialCreateOrganizationActionState };

/**
 * Creates an organizations row plus its organization_settings row - the two
 * tables lib/auth/bootstrap.ts's single-org bootstrap path also creates
 * together (read there for exactly what a correctly-initialized org needs;
 * that file itself is left untouched). Deliberately does NOT also create a
 * first org_admin membership - unlike the bootstrap path, this platform
 * console separates "create the organization" from "become a member of it"
 * (see JoinOrganizationButton/app/platform/actions.ts), so a super_admin can
 * create an org for a customer without themselves becoming a member of it.
 *
 * Both inserts go through the service-role client: organizations has no
 * insert policy for authenticated clients at all (see
 * supabase/migrations/0006_rls_policies.sql) - creating one is meant to be
 * possible only through this exact, audited, requirePlatformRole()-gated path.
 */
export async function createOrganizationAction(
  _prev: CreateOrganizationActionState,
  formData: FormData,
): Promise<CreateOrganizationActionState> {
  const session = await requirePlatformRole();

  const parsed = parseOrganizationInput(String(formData.get("name") ?? ""), String(formData.get("slug") ?? ""));
  if ("field" in parsed) return { error: parsed.message };

  const { domains, invalid } = parseAllowedDomainsInput(String(formData.get("allowedDomains") ?? ""));
  if (invalid.length > 0) {
    return {
      error: `Enter bare domains only (e.g. "lecfl.com"), not an email or URL. Couldn't parse: ${invalid.join(", ")}`,
    };
  }

  const supabase = createServiceRoleClient();

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .insert({ name: parsed.name, slug: parsed.slug, allowed_domains: domains })
    .select("id, name")
    .single();
  if (orgError) {
    return {
      error: describeDatabaseError(
        orgError,
        orgError.code === "23505" ? "That slug is already in use - choose a different one." : "Couldn't create the organization.",
      ),
    };
  }

  const { error: settingsError } = await supabase.from("organization_settings").insert({ organization_id: org.id });
  if (settingsError) {
    return {
      error: describeDatabaseError(settingsError, "Created the organization, but couldn't initialize its settings."),
    };
  }

  const { error: auditError } = await supabase.from("audit_logs").insert({
    organization_id: org.id,
    actor_id: session.userId,
    action: "platform.organization_created",
    target_type: "organization",
    target_id: org.id,
    metadata: { name: parsed.name, slug: parsed.slug, allowed_domains: domains },
  });
  if (auditError) {
    return { error: describeDatabaseError(auditError, "Created the organization, but couldn't record the audit log entry.") };
  }

  revalidatePath(routes.platform);
  return {
    success: `Created ${org.name}. Use "Join organization as admin" from the Overview page, or have an invited admin sign in, to add a first admin.`,
  };
}
