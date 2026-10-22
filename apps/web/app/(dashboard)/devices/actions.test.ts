import { beforeEach, describe, expect, it, vi } from "vitest";

class RedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`);
  }
}
const session = { userId: "u1", membership: { organization_id: "org1", role: "staff", department: null } as unknown };
let authed = true;
vi.mock("@/lib/auth/session", () => ({
  requireSessionOrRedirect: async () => {
    if (!authed) throw new RedirectSignal("/login");
    return session;
  },
}));
const supabase = { marker: "user-client" };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabase }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let baseDomain: string | null = "szvtech.org";
vi.mock("@/lib/env", () => ({ getGatewayEnv: () => ({ sharedSecret: null, baseDomain }) }));

const createDevice = vi.fn();
const revokeDevice = vi.fn();
vi.mock("@/lib/devices/devices", () => ({
  createDevice: (...a: unknown[]) => createDevice(...a),
  revokeDevice: (...a: unknown[]) => revokeDevice(...a),
}));

import { addDeviceAction, revokeDeviceAction } from "./actions";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

beforeEach(() => {
  createDevice.mockReset();
  revokeDevice.mockReset();
  authed = true;
  baseDomain = "szvtech.org";
  session.membership = { organization_id: "org1", role: "staff", department: null };
});

describe("addDeviceAction", () => {
  it("rejects unauthenticated callers", async () => {
    authed = false;
    await expect(addDeviceAction({}, fd({ name: "Pixel", deviceType: "android" }))).rejects.toMatchObject({ to: "/login" });
    expect(createDevice).not.toHaveBeenCalled();
  });

  it("returns the createDevice error inline", async () => {
    createDevice.mockResolvedValue({ ok: false, error: "Give this device a name." });
    expect(await addDeviceAction({}, fd({ name: "", deviceType: "android" }))).toEqual({ error: "Give this device a name.", fieldErrors: { name: "Give this device a name." } });
  });

  it("flags a missing type on the type field", async () => {
    createDevice.mockResolvedValue({ ok: false, error: "Choose what kind of device this is." });
    const res = await addDeviceAction({}, fd({ name: "x", deviceType: "" }));
    expect(res.fieldErrors?.deviceType).toBeDefined();
  });

  it("calls createDevice with the member's own client and returns the address", async () => {
    createDevice.mockResolvedValue({
      ok: true,
      device: { id: "d1", name: "Pixel", device_type: "android" },
      token: "rawtoken",
      hostname: "u-rawtoken.szvtech.org",
    });
    const res = await addDeviceAction({}, fd({ name: "Pixel", deviceType: "android" }));
    expect(createDevice).toHaveBeenCalledWith(supabase, { organizationId: "org1", userId: "u1", name: "Pixel", deviceType: "android", baseDomain: "szvtech.org" });
    expect(res.created).toEqual({
      deviceId: "d1",
      name: "Pixel",
      deviceType: "android",
      hostname: "u-rawtoken.szvtech.org",
      url: "https://u-rawtoken.szvtech.org/ipp/print",
    });
    expect(res.error).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('"token"');
  });

  it("errors when the member has no organization", async () => {
    session.membership = null;
    const res = await addDeviceAction({}, fd({ name: "P", deviceType: "android" }));
    expect(res.error).toBeTruthy();
    expect(createDevice).not.toHaveBeenCalled();
  });
});

describe("revokeDeviceAction", () => {
  it("rejects unauthenticated callers", async () => {
    authed = false;
    await expect(revokeDeviceAction({}, fd({ deviceId: "d1" }))).rejects.toMatchObject({ to: "/login" });
    expect(revokeDevice).not.toHaveBeenCalled();
  });

  it("revokes only as the signed-in member (never asAdmin)", async () => {
    revokeDevice.mockResolvedValue({ ok: true });
    const res = await revokeDeviceAction({}, fd({ deviceId: "d1" }));
    expect(revokeDevice).toHaveBeenCalledWith(supabase, { deviceId: "d1", organizationId: "org1", userId: "u1" });
    expect(res).toEqual({ revokedId: "d1" });
  });

  it("returns an error when the device is not theirs", async () => {
    revokeDevice.mockResolvedValue({ ok: false, error: "Device not found." });
    expect(await revokeDeviceAction({}, fd({ deviceId: "other" }))).toEqual({ error: "Device not found." });
  });

  it("requires a device id", async () => {
    const res = await revokeDeviceAction({}, fd({}));
    expect(res.error).toBeTruthy();
    expect(revokeDevice).not.toHaveBeenCalled();
  });
});
