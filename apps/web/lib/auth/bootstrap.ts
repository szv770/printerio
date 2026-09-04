import "server-only";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getBootstrapEnv } from "@/lib/env";

/**
 * Single-org bootstrap (this session's scope: prototype on the operator's own
 * org/printer first, full multi-tenant schema kept intact for later - see
 * docs/architecture.md sec 2.2).
 *
 * This is NOT "first person from an allowed domain becomes admin" - that
 * pattern is explicitly forbidden. This is an explicit, operator-configured
 * env var (PRINTOS_BOOTSTRAP_ADMIN_EMAIL) naming exactly one account, and it
 * only ever fires once: the moment ANY organization exists in this deployment,
 * this path is permanently dead. Every user added after that goes through the
 * normal organization_invitations flow (an org_admin issues an invite/
 * enrollment code) - see lib/invitations.ts.
 *
 * Call this once, right after a successful sign-in (from the OAuth callback
 * route), before redirecting. Safe to call on every sign-in - it's a fast
 * no-op once bootstrapped.
 */
export async function maybeBootstrapOrganization(userId: string, email: string): Promise<void> {
  const { PRINTOS_BOOTSTRAP_ADMIN_EMAIL } = getBootstrapEnv();
  const bootstrapEmail = PRINTOS_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (!bootstrapEmail) return;
  if (email.trim().toLowerCase() !== bootstrapEmail) return;

  const supabase = createServiceRoleClient();

  // Global guard: once any organization exists, this path is dead forever,
  // regardless of who signs in with what email.
  const { count, error: countError } = await supabase
    .from("organizations")
    .select("id", { count: "exact", head: true });
  if (countError) throw countError;
  if ((count ?? 0) > 0) return;

  const orgName = getBootstrapEnv().PRINTOS_BOOTSTRAP_ORG_NAME?.trim() || "My Organization";
  const slug = slugify(orgName) || `org-${userId.slice(0, 8)}`;

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .insert({ name: orgName, slug })
    .select("id")
    .single();
  if (orgError) throw orgError;

  const { error: settingsError } = await supabase
    .from("organization_settings")
    .insert({ organization_id: org.id });
  if (settingsError) throw settingsError;

  const { error: memberError } = await supabase
    .from("organization_members")
    .insert({ user_id: userId, organization_id: org.id, role: "org_admin", status: "active" });
  if (memberError) throw memberError;

  await supabase.from("audit_logs").insert({
    organization_id: org.id,
    actor_id: userId,
    action: "organization.bootstrapped",
    target_type: "organization",
    target_id: org.id,
    metadata: { via: "PRINTOS_BOOTSTRAP_ADMIN_EMAIL" },
  });
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
