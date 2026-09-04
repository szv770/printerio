import "server-only";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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

export function hashDeviceSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyDeviceSecret(secret: string, stored: string): boolean {
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

  return { id: agent.id, organizationId: agent.organization_id };
}
