import { describe, expect, it } from "vitest";
import { hashDeviceToken, tokenFromHost } from "@printio/shared/device-token";
import { fakeSupabase, failure, ok } from "@/test/fake-supabase";
import {
  createDevice,
  deleteDevice,
  DEVICE_COLUMNS,
  listDevicesForAdmin,
  listDevicesForMember,
  MAX_EVENTS_PER_DEVICE,
  recordDeviceEvent,
  revokeDevice,
} from "./devices";

const deviceRow = {
  id: "d1",
  organization_id: "org1",
  user_id: "u1",
  name: "Pixel 8",
  device_type: "android",
  created_at: "2026-10-22T00:00:00Z",
  revoked_at: null,
  first_seen_at: null,
  last_seen_at: null,
  last_user_agent: null,
  first_job_at: null,
  first_printed_at: null,
};

describe("createDevice", () => {
  it("stores only the hash, returns the raw token once and an address that round-trips", async () => {
    const fake = fakeSupabase(() => ok(deviceRow));
    const res = await createDevice(fake.client as never, {
      organizationId: "org1",
      userId: "u1",
      name: "  Pixel   8 ",
      deviceType: "android",
      baseDomain: "szvtech.org",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const insert = fake.calls.find((c) => c.op === "insert")!;
    const values = insert.values as Record<string, unknown>;
    expect(values.name).toBe("Pixel 8");
    expect(values.token_hash).toBe(hashDeviceToken(res.token));
    expect(JSON.stringify(values)).not.toContain(res.token);
    expect(res.hostname).toBe(`u-${res.token}.szvtech.org`);
    expect(tokenFromHost(res.hostname, "szvtech.org")).toBe(res.token);
    // The row handed back never carries the hash.
    expect(res.device).not.toHaveProperty("token_hash");
    expect(insert.filters).toContainEqual(["returning", DEVICE_COLUMNS]);
    expect(DEVICE_COLUMNS).not.toContain("token_hash");
  });

  it.each([
    ["an empty name", { name: "   ", deviceType: "android", baseDomain: "szvtech.org" }, /name/i],
    ["a very long name", { name: "x".repeat(81), deviceType: "android", baseDomain: "szvtech.org" }, /shorter/i],
    ["an unknown type", { name: "Phone", deviceType: "toaster", baseDomain: "szvtech.org" }, /kind of device/i],
    ["no base domain configured", { name: "Phone", deviceType: "android", baseDomain: null }, /not set up yet/i],
  ])("refuses %s without touching the database", async (_n, input, message) => {
    const fake = fakeSupabase(() => ok(deviceRow));
    const res = await createDevice(fake.client as never, { organizationId: "org1", userId: "u1", ...input });
    expect(res).toMatchObject({ ok: false });
    expect(res.ok ? "" : res.error).toMatch(message);
    expect(fake.calls).toHaveLength(0);
  });

  it("returns a plain error (not the database's) when the insert fails", async () => {
    const fake = fakeSupabase(() => failure("duplicate key value violates unique constraint member_devices_token_hash_key"));
    const res = await createDevice(fake.client as never, { organizationId: "o", userId: "u", name: "x", deviceType: "mac", baseDomain: "szvtech.org" });
    expect(res).toEqual({ ok: false, error: "Could not add this device. Try again." });
  });
});

describe("revokeDevice", () => {
  it("sets revoked_at on the member's own, still-active device only", async () => {
    const fake = fakeSupabase(() => ok([{ id: "d1" }]));
    const res = await revokeDevice(fake.client as never, { deviceId: "d1", organizationId: "org1", userId: "u1" });
    expect(res).toEqual({ ok: true });
    const update = fake.calls.find((c) => c.op === "update")!;
    expect((update.values as { revoked_at: string }).revoked_at).toMatch(/^\d{4}-/);
    expect(update.filters).toEqual(
      expect.arrayContaining([
        ["eq", "id", "d1"],
        ["eq", "organization_id", "org1"],
        ["is", "revoked_at", null],
        ["eq", "user_id", "u1"],
      ]),
    );
  });

  it("lets an admin revoke any device of the organization (no owner filter)", async () => {
    const fake = fakeSupabase(() => ok([{ id: "d1" }]));
    await revokeDevice(fake.client as never, { deviceId: "d1", organizationId: "org1", userId: "admin", asAdmin: true });
    const update = fake.calls.find((c) => c.op === "update")!;
    expect(update.filters.some((f) => f[0] === "eq" && f[1] === "user_id")).toBe(false);
    expect(update.filters).toContainEqual(["eq", "organization_id", "org1"]);
  });

  it("treats a device that is already off as done, and someone else's device as not found", async () => {
    const already = fakeSupabase((c) => (c.op === "update" ? ok([]) : ok({ id: "d1", revoked_at: "2026-10-01T00:00:00Z" })));
    expect(await revokeDevice(already.client as never, { deviceId: "d1", organizationId: "o", userId: "u" })).toEqual({ ok: true });

    const missing = fakeSupabase((c) => (c.op === "update" ? ok([]) : ok(null)));
    expect(await revokeDevice(missing.client as never, { deviceId: "d1", organizationId: "o", userId: "u" })).toEqual({
      ok: false,
      error: "Device not found.",
    });
  });
});

describe("deleteDevice", () => {
  it("deletes only the member's own device within their organization", async () => {
    const fake = fakeSupabase(() => ok([{ id: "d1" }]));
    const res = await deleteDevice(fake.client as never, { deviceId: "d1", organizationId: "org1", userId: "u1" });
    expect(res).toEqual({ ok: true });
    const del = fake.calls.find((c) => c.op === "delete")!;
    expect(del.table).toBe("member_devices");
    expect(del.filters).toEqual(
      expect.arrayContaining([
        ["eq", "id", "d1"],
        ["eq", "organization_id", "org1"],
        ["eq", "user_id", "u1"],
      ]),
    );
  });

  it("lets an admin delete any device of the organization (no owner filter, still org scoped)", async () => {
    const fake = fakeSupabase(() => ok([{ id: "d1" }]));
    await deleteDevice(fake.client as never, { deviceId: "d1", organizationId: "org1", userId: "admin", asAdmin: true });
    const del = fake.calls.find((c) => c.op === "delete")!;
    expect(del.filters.some((f) => f[0] === "eq" && f[1] === "user_id")).toBe(false);
    expect(del.filters).toContainEqual(["eq", "organization_id", "org1"]);
  });

  it("says Device not found when nothing was deleted (not theirs, other org, or already gone)", async () => {
    const fake = fakeSupabase(() => ok([]));
    expect(await deleteDevice(fake.client as never, { deviceId: "d1", organizationId: "o", userId: "u" })).toEqual({ ok: false, error: "Device not found." });
  });

  it("returns a friendly error when the delete fails", async () => {
    const fake = fakeSupabase(() => failure("boom"));
    const res = await deleteDevice(fake.client as never, { deviceId: "d1", organizationId: "o", userId: "u" });
    expect(res).toEqual({ ok: false, error: "Could not delete this device. Try again." });
  });
});

describe("listing", () => {
  it("lists a member's devices with the safe column list, scoped by user and organization", async () => {
    const fake = fakeSupabase(() => ok([deviceRow]));
    const rows = await listDevicesForMember(fake.client as never, { userId: "u1", organizationId: "org1" });
    expect(rows).toEqual([deviceRow]);
    const q = fake.calls[0]!;
    expect(q.columns).toBe(DEVICE_COLUMNS);
    expect(q.filters).toEqual(expect.arrayContaining([["eq", "user_id", "u1"], ["eq", "organization_id", "org1"]]));
  });

  it("lists an organization's devices for an admin, never selecting token_hash", async () => {
    const fake = fakeSupabase(() => ok([deviceRow]));
    await listDevicesForAdmin(fake.client as never, { organizationId: "org1" });
    const q = fake.calls[0]!;
    expect(q.columns).not.toContain("token_hash");
    expect(q.columns).not.toBe("*");
    expect(q.filters).toContainEqual(["eq", "organization_id", "org1"]);
  });

  it("throws a plain error when the query fails", async () => {
    const fake = fakeSupabase(() => failure("permission denied for table member_devices"));
    await expect(listDevicesForAdmin(fake.client as never, { organizationId: "org1" })).rejects.toThrow(/Could not load devices/);
  });
});

describe("recordDeviceEvent", () => {
  it("appends the event and bumps last_seen_at / last_user_agent", async () => {
    const fake = fakeSupabase((c) => (c.op === "select" ? ok([]) : ok()));
    const done = await recordDeviceEvent(fake.client as never, { deviceId: "d1", type: "attributes_requested", userAgent: "Windows IPP", detail: { a: 1 } });
    expect(done).toBe(true);
    const insert = fake.calls.find((c) => c.table === "device_events" && c.op === "insert")!;
    expect(insert.values).toMatchObject({ device_id: "d1", type: "attributes_requested", user_agent: "Windows IPP", detail: { a: 1 } });
    const touch = fake.calls.find((c) => c.table === "member_devices" && c.op === "update")!;
    expect(touch.values).toMatchObject({ last_user_agent: "Windows IPP" });
    // Not a job: first_job_at is untouched.
    expect(fake.calls.filter((c) => c.table === "member_devices" && c.op === "update")).toHaveLength(1);
  });

  it("sets first_job_at only when it is still null, on job_received", async () => {
    const fake = fakeSupabase((c) => (c.op === "select" ? ok([]) : ok()));
    await recordDeviceEvent(fake.client as never, { deviceId: "d1", type: "job_received" });
    const first = fake.calls.filter((c) => c.table === "member_devices" && c.op === "update").find((c) => "first_job_at" in (c.values as object))!;
    expect(first.filters).toContainEqual(["is", "first_job_at", null]);
  });

  it("prunes events beyond the newest 200", async () => {
    const fake = fakeSupabase((c) => (c.op === "select" ? ok([{ id: "old1" }, { id: "old2" }]) : ok()));
    await recordDeviceEvent(fake.client as never, { deviceId: "d1", type: "info" });
    const select = fake.calls.find((c) => c.table === "device_events" && c.op === "select")!;
    expect(select.filters).toContainEqual(["range", MAX_EVENTS_PER_DEVICE, MAX_EVENTS_PER_DEVICE + 99]);
    const del = fake.calls.find((c) => c.op === "delete")!;
    expect(del.filters).toContainEqual(["in", "id", ["old1", "old2"]]);
  });

  it("returns false instead of throwing when the database is unhappy", async () => {
    const failing = fakeSupabase(() => failure());
    expect(await recordDeviceEvent(failing.client as never, { deviceId: "d1", type: "info" })).toBe(false);
    const throwing = fakeSupabase(() => {
      throw new Error("network down");
    });
    expect(await recordDeviceEvent(throwing.client as never, { deviceId: "d1", type: "info" })).toBe(false);
  });

  it("truncates an oversized user agent", async () => {
    const fake = fakeSupabase((c) => (c.op === "select" ? ok([]) : ok()));
    await recordDeviceEvent(fake.client as never, { deviceId: "d1", type: "info", userAgent: "x".repeat(5000) });
    const insert = fake.calls.find((c) => c.op === "insert")!;
    expect((insert.values as { user_agent: string }).user_agent).toHaveLength(300);
  });
});
