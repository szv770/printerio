import { createHash, randomBytes, scryptSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";

vi.mock("server-only", () => ({}));
let fake: ReturnType<typeof fakeSupabase>;
let respond: (c: FakeCall) => FakeResult;
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => fake.client }));

import { authenticateAgentRequest, generateDeviceSecret, hashDeviceSecret, verifyDeviceSecret } from "./agent-auth";

function legacyHash(secret: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(secret, salt, 64).toString("hex")}`;
}
const req = (token: string) => new Request("http://x/api/agents/heartbeat", { headers: { authorization: `Bearer ${token}` } });
const updates = () => fake.calls.filter((c) => c.table === "agents" && c.op === "update");

describe("device secret hashing", () => {
  it("new hashes use the fast sha256: format and verify", () => {
    const secret = generateDeviceSecret();
    const stored = hashDeviceSecret(secret);
    expect(stored).toBe(`sha256:${createHash("sha256").update(secret).digest("hex")}`);
    expect(verifyDeviceSecret(secret, stored)).toBe(true);
    expect(verifyDeviceSecret(secret + "x", stored)).toBe(false);
    expect(verifyDeviceSecret(secret, "sha256:abcd")).toBe(false);
  });

  it("still verifies the legacy salt:hash scrypt format", () => {
    const secret = generateDeviceSecret();
    const stored = legacyHash(secret);
    expect(verifyDeviceSecret(secret, stored)).toBe(true);
    expect(verifyDeviceSecret("wrong", stored)).toBe(false);
    expect(verifyDeviceSecret(secret, "garbage")).toBe(false);
  });
});

describe("authenticateAgentRequest", () => {
  const secret = generateDeviceSecret();
  let row: Record<string, unknown> | null;
  beforeEach(() => {
    row = { id: "a1", organization_id: "org-1", status: "active", paused: false, device_secret_hash: legacyHash(secret) };
    respond = (c) => (c.op === "select" ? ok(row) : ok());
    fake = fakeSupabase((c) => respond(c));
  });

  it("legacy hash: authenticates and upgrades the stored hash, guarded by the old value", async () => {
    const old = row!.device_secret_hash;
    const agent = await authenticateAgentRequest(req(`a1.${secret}`));
    expect(agent).toEqual({ id: "a1", organizationId: "org-1", paused: false });
    expect(updates()).toHaveLength(1);
    expect(updates()[0]!.values).toEqual({ device_secret_hash: hashDeviceSecret(secret) });
    expect(updates()[0]!.filters).toEqual(expect.arrayContaining([["eq", "id", "a1"], ["eq", "device_secret_hash", old]]));
  });

  it("a failed upgrade does not fail the request", async () => {
    respond = (c) => (c.op === "select" ? ok(row) : { data: null, error: { message: "boom" } });
    fake = fakeSupabase((c) => respond(c));
    expect(await authenticateAgentRequest(req(`a1.${secret}`))).not.toBeNull();
  });

  it("an upgrade that throws does not fail the request", async () => {
    fake = fakeSupabase((c) => {
      if (c.op === "select") return ok(row);
      throw new Error("network");
    });
    expect(await authenticateAgentRequest(req(`a1.${secret}`))).not.toBeNull();
  });

  it("new-format hash: authenticates with no write", async () => {
    row!.device_secret_hash = hashDeviceSecret(secret);
    expect(await authenticateAgentRequest(req(`a1.${secret}`))).not.toBeNull();
    expect(updates()).toHaveLength(0);
  });

  it("wrong secret, missing, paused-ok, inactive and revoked behave as before, with no write", async () => {
    expect(await authenticateAgentRequest(req(`a1.nope`))).toBeNull();
    row!.status = "revoked";
    expect(await authenticateAgentRequest(req(`a1.${secret}`))).toBeNull();
    row!.status = "active";
    row!.device_secret_hash = null;
    expect(await authenticateAgentRequest(req(`a1.${secret}`))).toBeNull();
    row = null;
    expect(await authenticateAgentRequest(req(`a1.${secret}`))).toBeNull();
    expect(updates()).toHaveLength(0);
    row = { id: "a1", organization_id: "org-1", status: "active", paused: true, device_secret_hash: hashDeviceSecret(secret) };
    expect((await authenticateAgentRequest(req(`a1.${secret}`)))?.paused).toBe(true);
  });
});
