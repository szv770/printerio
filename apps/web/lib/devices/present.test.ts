import { describe, expect, it } from "vitest";
import { detectDeviceType, deviceAddress, deviceStatus, deviceTypeLabel, noStepsMessage, setupSteps } from "./present";

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
    expect(deviceStatus(base).label).toBe("Device link created, not connected yet");
  });
});

describe("setupSteps", () => {
  const addr = deviceAddress("u-abc.szvtech.org");
  it("windows uses the full URL and the exact menu path", () => {
    const s = setupSteps("windows", addr)!;
    expect(s.needs).toBe("url");
    const text = s.steps.join("\n");
    expect(text).toContain("Add manually");
    expect(text).toContain("Add a printer using an IP address or hostname");
    expect(text).toContain("IPP Device");
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
  it("mac has Terminal and Settings steps, an ipps command, and is honestly labelled untested", () => {
    const s = setupSteps("mac", addr)!;
    expect(s.needs).toBe("hostname");
    expect(s.command).toBe("lpadmin -p Printio -E -v ipps://u-abc.szvtech.org/ipp/print -m everywhere");
    const text = s.steps.join(" ");
    expect(text).toContain("Terminal");
    expect(text).toContain("Add Printer");
    expect(text).toContain("IP tab");
    expect(text).toContain("u-abc.szvtech.org:443");
    expect(text).toContain("Recommended");
    expect(s.testStatus).toMatch(/Not tested yet - being worked on/);
    expect(s.testStatus).not.toMatch(/works/i);
  });
  it("only mac carries a command and a test status", () => {
    expect(setupSteps("windows", addr)!.command).toBeUndefined();
    expect(setupSteps("android", addr)!.testStatus).toBeUndefined();
  });
  it("other types have no steps yet", () => {
    for (const t of ["other"] as const) expect(setupSteps(t, addr)).toBeNull();
  });
  it("iPhone gets the profile route (proven), and no Terminal command", () => {
    const s = setupSteps("iphone", addr)!;
    expect(s.needs).toBe("hostname");
    expect(s.profileDownload).toBe(true);
    expect(s.testStatus).toBeUndefined(); // proven on a real iPhone 2026-10-25
    expect(s.command).toBeUndefined();
    const text = s.steps.join(" ");
    expect(text).toContain("Safari");
    expect(text).toContain("Profile Downloaded");
    expect(text).toMatch(/Unsigned/i);
    expect(text).toContain("Print");
  });
  it("Chromebook uses the manual Add printer form: hostname with port 443, IPPS, queue ipp/print; labelled not tested", () => {
    const s = setupSteps("chromebook", addr)!;
    expect(s.needs).toBe("hostname");
    expect(s.testStatus).toMatch(/not tested/i);
    expect(s.command).toBeUndefined();
    expect(s.profileDownload).toBeUndefined();
    const text = s.steps.join(" ");
    expect(text).toContain("Add printer");
    expect(text).toContain("u-abc.szvtech.org:443");
    expect(text).toMatch(/IPPS/);
    expect(text).toContain("ipp/print");
    expect(text).not.toContain("https://");
    expect(s.note).toMatch(/school|administrator|managed/i);
  });
  it("no other type offers the profile", () => {
    for (const t of ["windows", "android", "mac"] as const) expect(setupSteps(t, addr)!.profileDownload).toBeUndefined();
  });
});

describe("deviceTypeLabel", () => {
  it("labels types", () => {
    expect(deviceTypeLabel("windows")).toBe("Windows 11");
    expect(deviceTypeLabel("android")).toBe("Android");
    expect(deviceTypeLabel("weird")).toBe("Other");
  });
});

describe("detectDeviceType", () => {
  const ua = {
    win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    pixel: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
    chromebook: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    ipad: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    linux: "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  };
  it("recognises each kind of device", () => {
    expect(detectDeviceType(ua.win)).toBe("windows");
    expect(detectDeviceType(ua.pixel)).toBe("android");
    expect(detectDeviceType(ua.chromebook)).toBe("chromebook");
    expect(detectDeviceType(ua.iphone)).toBe("iphone");
    expect(detectDeviceType(ua.ipad)).toBe("iphone");
    expect(detectDeviceType(ua.mac)).toBe("mac");
  });
  it("treats a touch-screen Mac user agent as an iPad (iPadOS)", () => {
    expect(detectDeviceType(ua.mac, 5)).toBe("iphone");
    expect(detectDeviceType(ua.mac, 0)).toBe("mac");
  });
  it("falls back to other for anything unknown or empty", () => {
    expect(detectDeviceType(ua.linux)).toBe("other");
    expect(detectDeviceType("")).toBe("other");
    expect(detectDeviceType(undefined)).toBe("other");
  });
});

describe("noStepsMessage", () => {
  it("has no iPhone special case any more (iPhone now has steps)", () => {
    expect(noStepsMessage("iphone")).toMatch(/don't have steps/i);
  });
  it("says plainly that Other has no steps and may not work", () => {
    expect(noStepsMessage("other")).toBe("We don't have steps for this kind of device yet. It may not work.");
  });
  it("is generic for other types without steps", () => {
    expect(noStepsMessage("mac")).toMatch(/Mac/);
    expect(noStepsMessage("mac")).toMatch(/may not work/i);
  });
});
