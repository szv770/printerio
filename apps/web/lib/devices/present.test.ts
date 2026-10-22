import { describe, expect, it } from "vitest";
import { deviceAddress, deviceStatus, deviceTypeLabel, setupSteps } from "./present";

const base = {
  revoked_at: null,
  last_seen_at: null,
  first_job_at: null,
  first_printed_at: null,
};

describe("deviceAddress", () => {
  it("gives the bare hostname and the full print URL", () => {
    expect(deviceAddress("u-abc.szvtech.org")).toEqual({ hostname: "u-abc.szvtech.org", url: "https://u-abc.szvtech.org/ipp/print" });
  });
});

describe("deviceStatus", () => {
  it("walks from address created to printed, and revoked wins", () => {
    expect(deviceStatus(base).key).toBe("created");
    expect(deviceStatus({ ...base, last_seen_at: "x" }).key).toBe("connected");
    expect(deviceStatus({ ...base, last_seen_at: "x", first_job_at: "y" }).key).toBe("job_received");
    expect(deviceStatus({ ...base, last_seen_at: "x", first_job_at: "y", first_printed_at: "z" }).key).toBe("printed");
    expect(deviceStatus({ ...base, first_printed_at: "z", revoked_at: "r" }).key).toBe("revoked");
  });
  it("uses plain wording", () => {
    expect(deviceStatus({ ...base, revoked_at: "r" }).label).toBe("Turned off");
    expect(deviceStatus(base).label).toBe("Address created, not connected yet");
  });
});

describe("setupSteps", () => {
  const addr = deviceAddress("u-abc.szvtech.org");
  it("windows uses the full URL and the exact menu path", () => {
    const s = setupSteps("windows", addr)!;
    expect(s.needs).toBe("url");
    const text = s.steps.join("\n");
    expect(text).toContain("Add manually");
    expect(text).toContain("Select a shared printer by name");
    expect(text).toContain("https://u-abc.szvtech.org/ipp/print");
  });
  it("android uses the bare hostname and says so", () => {
    const s = setupSteps("android", addr)!;
    expect(s.needs).toBe("hostname");
    const text = s.steps.join("\n");
    expect(text).toContain("Add by IP/hostname");
    expect(text).toContain("u-abc.szvtech.org");
    expect(text).not.toContain("https://");
    expect(s.note).toMatch(/bare hostname/i);
  });
  it("other types have no steps yet", () => {
    for (const t of ["chromebook", "iphone", "mac", "other"] as const) expect(setupSteps(t, addr)).toBeNull();
  });
});

describe("deviceTypeLabel", () => {
  it("labels types", () => {
    expect(deviceTypeLabel("windows")).toBe("Windows 11");
    expect(deviceTypeLabel("android")).toBe("Android");
    expect(deviceTypeLabel("weird")).toBe("Other");
  });
});
