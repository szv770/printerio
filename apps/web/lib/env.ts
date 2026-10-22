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
  return parseOrThrowFrom(schema, process.env, groupName);
}

function parseOrThrowFrom<T extends z.ZodTypeAny>(schema: T, source: unknown, groupName: string): z.infer<T> {
  const result = schema.safeParse(source);
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
  PRINTIO_CRON_SECRET: z.string().min(1),
});
let cronEnvCache: z.infer<typeof cronEnvSchema> | null = null;

/** Only needed by app/api/cron/sweep - throws (never silently no-ops) if unset,
 *  so a misconfigured deployment gets a clear error instead of a route that
 *  quietly 401s every request forever with no clue why. */
export function getCronSecret(): string {
  return (cronEnvCache ??= parseOrThrow(cronEnvSchema, "the cron sweep route")).PRINTIO_CRON_SECRET;
}

/**
 * Bootstrap vars are intentionally all-optional with no throw: an unset
 * PRINTIO_BOOTSTRAP_ADMIN_EMAIL is the normal, permanent steady state once an
 * organization already exists (see lib/auth/bootstrap.ts) - that is not a
 * misconfiguration.
 */
const bootstrapEnvSchema = z.object({
  PRINTIO_BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  PRINTIO_BOOTSTRAP_ORG_NAME: z.string().min(1).optional(),
});

export function getBootstrapEnv() {
  // Every field is optional, so this only throws if PRINTIO_BOOTSTRAP_ADMIN_EMAIL
  // is *set* to something that isn't a valid email (a likely typo worth
  // surfacing loudly) - unset entirely is always fine and safe to call
  // unconditionally.
  return parseOrThrow(bootstrapEnvSchema, "organization bootstrap");
}

/**
 * IPP gateway settings (docs/superpowers/specs/2026-10-22-gateway-contract.md). Both are optional so the build and
 * deployments that do not run the gateway keep working: the /api/gateway routes answer 503 until the secret is set,
 * and the "add a device" helpers refuse until the base domain is set.
 */
const gatewayEnvSchema = z.object({
  GATEWAY_SHARED_SECRET: z.string().min(32, "must be at least 32 characters").optional(),
  GATEWAY_BASE_DOMAIN: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, "must be a bare domain such as szvtech.org")
    .optional(),
});

export function getGatewayEnv(): { sharedSecret: string | null; baseDomain: string | null } {
  // Empty strings (an env var declared but left blank) count as unset.
  const raw = {
    GATEWAY_SHARED_SECRET: process.env.GATEWAY_SHARED_SECRET || undefined,
    GATEWAY_BASE_DOMAIN: process.env.GATEWAY_BASE_DOMAIN || undefined,
  };
  const parsed = parseOrThrowFrom(gatewayEnvSchema, raw, "the IPP gateway");
  return { sharedSecret: parsed.GATEWAY_SHARED_SECRET ?? null, baseDomain: parsed.GATEWAY_BASE_DOMAIN?.toLowerCase() ?? null };
}
