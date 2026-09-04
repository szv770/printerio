import "server-only";
import { z } from "zod";

/**
 * Validated, typed access to environment variables - grouped by who actually
 * needs each group, not one giant all-or-nothing schema. A page that only
 * touches the public Supabase client should not fail to render just because
 * an operator hasn't configured the cron secret yet; each accessor below
 * validates and throws a clear, specific error only when that group is
 * actually used, naming exactly which variable is missing/invalid and
 * pointing at apps/web/.env.example - never a cryptic
 * "Cannot read property of undefined" three files deep.
 *
 * Each accessor caches its parsed result (env vars don't change within a
 * running process), so this is cheap to call on every request.
 */

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, groupName: string): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(
      `Missing or invalid environment variables for ${groupName}:\n${issues}\n` +
        `See apps/web/.env.example for the full list and what each one is for.`,
    );
  }
  return result.data;
}

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url("must be a valid URL, e.g. https://xyz.supabase.co"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});
let publicEnvCache: z.infer<typeof publicEnvSchema> | null = null;

/** Required by every Supabase client (browser, server, service-role). */
export function getPublicEnv() {
  return (publicEnvCache ??= parseOrThrow(publicEnvSchema, "Supabase client (public)"));
}

const serviceRoleEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});
let serviceRoleEnvCache: z.infer<typeof serviceRoleEnvSchema> | null = null;

/** Only needed where lib/supabase/service-role.ts is actually imported. */
export function getServiceRoleEnv() {
  return (serviceRoleEnvCache ??= parseOrThrow(serviceRoleEnvSchema, "the service-role client"));
}

const cronEnvSchema = z.object({
  PRINTOS_CRON_SECRET: z.string().min(1),
});
let cronEnvCache: z.infer<typeof cronEnvSchema> | null = null;

/** Only needed by app/api/cron/sweep - throws (never silently no-ops) if unset,
 *  so a misconfigured deployment gets a clear error instead of a route that
 *  quietly 401s every request forever with no clue why. */
export function getCronSecret(): string {
  return (cronEnvCache ??= parseOrThrow(cronEnvSchema, "the cron sweep route")).PRINTOS_CRON_SECRET;
}

/**
 * Bootstrap vars are intentionally all-optional with no throw: an unset
 * PRINTOS_BOOTSTRAP_ADMIN_EMAIL is the normal, permanent steady state once an
 * organization already exists (see lib/auth/bootstrap.ts) - that is not a
 * misconfiguration.
 */
const bootstrapEnvSchema = z.object({
  PRINTOS_BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  PRINTOS_BOOTSTRAP_ORG_NAME: z.string().min(1).optional(),
});

export function getBootstrapEnv() {
  // Every field is optional, so this only throws if PRINTOS_BOOTSTRAP_ADMIN_EMAIL
  // is *set* to something that isn't a valid email (a likely typo worth
  // surfacing loudly) - unset entirely is always fine and safe to call
  // unconditionally.
  return parseOrThrow(bootstrapEnvSchema, "organization bootstrap");
}
