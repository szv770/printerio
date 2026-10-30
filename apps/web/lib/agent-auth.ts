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
 * microseconds instead of tens of ms of CPU per request. New and rotated secrets are stored as
 * `sha256:<hex>`. Legacy `salt:hash` (scrypt) rows still verify, and are upgraded on first use.
 */
const FAST_PREFIX = "sha256:";

function sha256Hex(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function hashDeviceSecret(secret: string): string {
  return `${FAST_PREFIX}${sha256Hex(secret)}`;
}

export function isLegacyDeviceSecretHash(stored: string): boolean {
  return !stored.startsWith(FAST_PREFIX);
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
  /** What this agent last reported (already loaded by auth), so the heartbeat can skip rewriting identical values. Absent in test doubles. */
  reported?: {
    version: string | null;
    discovered_queues: unknown;
    hostname: string | null;
    os_version: string | null;
    ip_addresses: string[] | null;
    is_git_checkout: boolean | null;
  };
}

/** Only the columns authentication and the heartbeat's change-detection use. */
const AGENT_AUTH_COLUMNS =
  "id, organization_id, status, paused, device_secret_hash, version, discovered_queues, hostname, os_version, ip_addresses, is_git_checkout";

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
  const { data: agent } = await supabase.from("agents").select(AGENT_AUTH_COLUMNS).eq("id", agentId).maybeSingle();
  if (!agent || agent.status !== "active" || !agent.device_secret_hash) return null;
  if (!verifyDeviceSecret(secret, agent.device_secret_hash)) return null;

  if (isLegacyDeviceSecretHash(agent.device_secret_hash)) {
    // Best effort: move this agent to the fast format. Guarded by the old value so a concurrent rotate wins,
    // and never allowed to fail the request.
    try {
      await supabase
        .from("agents")
        .update({ device_secret_hash: hashDeviceSecret(secret) })
        .eq("id", agent.id)
        .eq("device_secret_hash", agent.device_secret_hash);
    } catch {
      // ignore - the next request retries
    }
  }

  return {
    id: agent.id,
    organizationId: agent.organization_id,
    paused: agent.paused,
    reported: {
      version: agent.version,
      discovered_queues: agent.discovered_queues,
      hostname: agent.hostname,
      os_version: agent.os_version,
      ip_addresses: agent.ip_addresses,
      is_git_checkout: agent.is_git_checkout,
    },
  };
}
