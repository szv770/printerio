import "server-only";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

/**
 * Agent device-credential handling (docs/architecture.md sec 4 / docs/agent-api.md).
 * The Agent authenticates with its own bearer secret - never a Supabase Auth
 * JWT, never the service-role key. Every agent-facing route handler in
 * app/api/agents/** uses authenticateAgentRequest() and then queries with the
 * service-role client, manually re-checking organization_id on every row it
 * touches (the Agent has no Supabase session for RLS to key off of).
 */

export function generateDeviceSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The device secret is 32 random bytes, so a slow KDF adds nothing: a plain SHA-256 is enough and costs
 * microseconds instead of tens of ms of CPU per request. Rows stored as `sha256:<hex>` verify the fast way;
 * legacy `salt:hash` (scrypt) rows still verify.
 */
const FAST_PREFIX = "sha256:";

function sha256Hex(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// Step 1 of a two-step rollout: new secrets are still written in the legacy format, so reverting this
// release is safe. Step 2 switches writing (and the lazy upgrade) to `sha256:`.
export function hashDeviceSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyDeviceSecret(secret: string, stored: string): boolean {
  if (stored.startsWith(FAST_PREFIX)) {
    const expected = Buffer.from(stored.slice(FAST_PREFIX.length), "hex");
    const candidate = Buffer.from(sha256Hex(secret), "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const candidate = scryptSync(secret, salt, 64);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export interface AuthenticatedAgent {
  id: string;
  organizationId: string;
  /**
   * `agents.paused` - true while an org_admin is deliberately holding this
   * Agent back from taking new print jobs. Surfaced here, on the one
   * function every agent-facing route already calls, so the two routes that
   * hand out work (`jobs/claimable`, `jobs/[jobId]/claim`) enforce the pause
   * without a second lookup and without any route being able to forget the
   * check by accident. Note this is deliberately NOT part of the
   * authentication decision: a paused Agent still authenticates normally and
   * still heartbeats (that's how it stays visible in the console, and how it
   * learns it is paused) - only job claiming is refused.
   */
  paused: boolean;
}

/** Parses and verifies the `Authorization: Bearer <agentId>.<deviceSecret>` header. */
export async function authenticateAgentRequest(request: Request): Promise<AuthenticatedAgent | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice("Bearer ".length).trim();
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const agentId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!agentId || !secret) return null;

  const supabase = createServiceRoleClient();
  const { data: agent } = await supabase.from("agents").select("*").eq("id", agentId).maybeSingle();
  if (!agent || agent.status !== "active" || !agent.device_secret_hash) return null;
  if (!verifyDeviceSecret(secret, agent.device_secret_hash)) return null;

  return { id: agent.id, organizationId: agent.organization_id, paused: agent.paused };
}
