import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  WEB_BASE_URL: "https://printio.example",
  GATEWAY_SHARED_SECRET: "x".repeat(40),
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  BASE_DOMAIN: "example.test",
};
const MB = 1024 * 1024;

describe("busy guard configuration", () => {
  it("defaults: 150 MB of uploads in flight, 2 per device, 50 MB per file", () => {
    const c = loadConfig(base);
    expect(c.maxInflightUploadBytes).toBe(150 * MB);
    expect(c.maxUploadsPerDevice).toBe(2);
    expect(c.maxBodyBytes).toBe(50 * MB);
  });
  it("is set with MAX_INFLIGHT_UPLOAD_MB and MAX_UPLOADS_PER_DEVICE", () => {
    const c = loadConfig({ ...base, MAX_INFLIGHT_UPLOAD_MB: "300", MAX_UPLOADS_PER_DEVICE: "3" });
    expect(c.maxInflightUploadBytes).toBe(300 * MB);
    expect(c.maxUploadsPerDevice).toBe(3);
  });
  it("the cap can never be lower than one legal file (otherwise a file at the per-file limit would be busy for ever)", () => {
    const c = loadConfig({ ...base, MAX_UPLOAD_MB: "50", MAX_INFLIGHT_UPLOAD_MB: "10" });
    expect(c.maxInflightUploadBytes).toBe(50 * MB);
  });
  it("rejects nonsense", () => {
    expect(() => loadConfig({ ...base, MAX_UPLOADS_PER_DEVICE: "0" })).toThrow();
    expect(() => loadConfig({ ...base, MAX_INFLIGHT_UPLOAD_MB: "-1" })).toThrow();
  });
});

describe("ADVERTISE_FINISHINGS", () => {
  const base = {
    WEB_BASE_URL: "https://web.test",
    GATEWAY_SHARED_SECRET: "x".repeat(32),
    SUPABASE_URL: "https://sb.test",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    BASE_DOMAIN: "example.test",
  };
  it("defaults to full and accepts basic", () => {
    expect(loadConfig(base).advertiseFinishings).toBe("full");
    expect(loadConfig({ ...base, ADVERTISE_FINISHINGS: "basic" }).advertiseFinishings).toBe("basic");
  });
  it("rejects other values", () => {
    expect(() => loadConfig({ ...base, ADVERTISE_FINISHINGS: "lots" })).toThrow();
  });
});
