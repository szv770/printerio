import { describe, expect, it } from "vitest";
import { feedbackCardDevices, setupKeyFor, setupMethodLabel, summarizeSetups, validateFeedback, SETUP_KEYS } from "./setup-feedback";

const NOW = new Date("2026-10-23T12:00:00Z");
const dev = (o: Record<string, unknown> = {}) => ({
  id: "d1", name: "My PC", device_type: "windows", revoked_at: null, first_printed_at: "2026-10-23T10:00:00Z", ...o,
});

describe("setupKeyFor (must match private.setup_key_for in migration 0042)", () => {
  it("maps the three documented setups and everything else to other_*", () => {
    expect(setupKeyFor("windows")).toBe("windows_manual_wizard");
    expect(setupKeyFor("android")).toBe("android_bare_host");
    expect(setupKeyFor("mac")).toBe("mac_lpadmin");
    expect(setupKeyFor("chromebook")).toBe("other_chromebook");
    expect(setupKeyFor("mac", "ip_tab")).toBe("mac_ip_tab");
    expect(setupKeyFor("mac", "terminal")).toBe("mac_lpadmin");
  });
  it("has a plain label for each documented setup", () => {
    for (const k of SETUP_KEYS) expect(setupMethodLabel(k)).toMatch(/\w/);
    expect(setupMethodLabel("mac_lpadmin")).toMatch(/Mac/);
  });
});

describe("feedbackCardDevices", () => {
  const base = { answered: new Set<string>(), openIssues: new Map<string, number>(), failedJobs: new Map<string, number>(), now: NOW };
  it("asks about a device whose first print came out with no errors and no answer yet", () => {
    expect(feedbackCardDevices([dev()], base).map((d) => d.id)).toEqual(["d1"]);
  });
  it("does not ask before anything printed, after turning off, after an answer, or with open problems", () => {
    expect(feedbackCardDevices([dev({ first_printed_at: null })], base)).toEqual([]);
    expect(feedbackCardDevices([dev({ revoked_at: "2026-10-23T11:00:00Z" })], base)).toEqual([]);
    expect(feedbackCardDevices([dev()], { ...base, answered: new Set(["d1"]) })).toEqual([]);
    expect(feedbackCardDevices([dev()], { ...base, openIssues: new Map([["d1", 1]]) })).toEqual([]);
  });
  it("does not ask when a job from this device failed (the existing problem flow covers that)", () => {
    expect(feedbackCardDevices([dev()], { ...base, failedJobs: new Map([["d1", 1]]) })).toEqual([]);
  });
  it("stops asking about very old first prints", () => {
    expect(feedbackCardDevices([dev({ first_printed_at: "2026-08-01T00:00:00Z" })], base)).toEqual([]);
  });
});

describe("validateFeedback", () => {
  it("accepts yes, and a problem with a trimmed note", () => {
    expect(validateFeedback({ outcome: "ok", note: "ignored" })).toEqual({ ok: true, outcome: "ok", note: "", variant: null });
    expect(validateFeedback({ outcome: "problem", note: "  wrong tray  " })).toEqual({ ok: true, outcome: "problem", note: "wrong tray", variant: null });
    expect(validateFeedback({ outcome: "ok", note: "", variant: "ip_tab" })).toMatchObject({ variant: "ip_tab" });
    expect(validateFeedback({ outcome: "ok", note: "", variant: "bogus" })).toMatchObject({ variant: null });
  });
  it("rejects unknown outcomes and over-long notes", () => {
    expect(validateFeedback({ outcome: "maybe", note: "" }).ok).toBe(false);
    expect(validateFeedback({ outcome: "problem", note: "x".repeat(1001) }).ok).toBe(false);
  });
});

describe("summarizeSetups", () => {
  const fb = (setup_key: string, outcome: "ok" | "problem", user_id: string, note = "") => ({ setup_key, outcome, user_id, note, created_at: "2026-10-23T09:00:00Z" });
  it("shows Not tested yet when nobody answered and nobody confirmed", () => {
    const s = summarizeSetups([], []).find((x) => x.key === "mac_lpadmin")!;
    expect(s).toMatchObject({ status: "not_tested", statusLabel: "Not tested yet", worked: 0, problems: 0 });
  });
  it("counts distinct people who said it worked", () => {
    const s = summarizeSetups([fb("windows_manual_wizard", "ok", "u1"), fb("windows_manual_wizard", "ok", "u2"), fb("windows_manual_wizard", "problem", "u3", "no paper")], []).find((x) => x.key === "windows_manual_wizard")!;
    expect(s).toMatchObject({ status: "reported", statusLabel: "Reported working by 2 people", worked: 2, problems: 1 });
    expect(s.problemNotes).toEqual(["no paper"]);
  });
  it("uses singular for one person", () => {
    expect(summarizeSetups([fb("android_bare_host", "ok", "u1")], []).find((x) => x.key === "android_bare_host")!.statusLabel).toBe("Reported working by 1 person");
  });
  it("an admin confirmation wins and is labelled Confirmed working", () => {
    const s = summarizeSetups([fb("mac_lpadmin", "problem", "u1")], [{ setup_key: "mac_lpadmin" }]).find((x) => x.key === "mac_lpadmin")!;
    expect(s).toMatchObject({ status: "confirmed", statusLabel: "Confirmed working", confirmed: true, problems: 1 });
  });
  it("only a problem report still reads Not tested yet (never claims it works)", () => {
    const s = summarizeSetups([fb("mac_lpadmin", "problem", "u1")], []).find((x) => x.key === "mac_lpadmin")!;
    expect(s.status).toBe("not_tested");
    expect(s.problems).toBe(1);
  });
});
