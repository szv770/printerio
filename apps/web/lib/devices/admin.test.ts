import { describe, expect, it } from "vitest";
import { ISSUE_KINDS, issueKindLabel, MAX_ISSUE_NOTE, STUCK_AFTER_MS, sortStuckFirst, stuckReason, validateIssueInput, validateResolveNote } from "./admin";

const NOW = new Date("2026-10-22T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const dev = (o: Partial<Parameters<typeof stuckReason>[0]> = {}) => ({
  id: "d",
  revoked_at: null,
  first_seen_at: null,
  last_seen_at: null,
  first_job_at: null,
  first_printed_at: null,
  created_at: ago(1000),
  ...o,
});

describe("validateIssueInput", () => {
  it("accepts every kind and trims the note", () => {
    for (const k of ISSUE_KINDS) expect(validateIssueInput({ kind: k, note: "  hi  " })).toEqual({ ok: true, kind: k, note: "hi" });
  });
  it("allows an empty note", () => {
    expect(validateIssueInput({ kind: "other", note: "" })).toMatchObject({ ok: true, note: "" });
  });
  it("rejects an unknown or missing kind", () => {
    expect(validateIssueInput({ kind: "boom", note: "" })).toMatchObject({ ok: false, field: "kind" });
    expect(validateIssueInput({ kind: "", note: "" })).toMatchObject({ ok: false, field: "kind" });
  });
  it("rejects a note over the limit", () => {
    expect(validateIssueInput({ kind: "other", note: "x".repeat(MAX_ISSUE_NOTE + 1) })).toMatchObject({ ok: false, field: "note" });
    expect(validateIssueInput({ kind: "other", note: "x".repeat(MAX_ISSUE_NOTE) }).ok).toBe(true);
  });
  it("has a plain label per kind", () => {
    expect(issueKindLabel("cant_add")).toMatch(/add/i);
    expect(issueKindLabel("zzz")).toBe("Something else");
  });
});

describe("validateResolveNote", () => {
  it("trims, allows empty, caps length", () => {
    expect(validateResolveNote("  done ")).toEqual({ ok: true, note: "done" });
    expect(validateResolveNote("")).toEqual({ ok: true, note: "" });
    expect(validateResolveNote("x".repeat(MAX_ISSUE_NOTE + 1)).ok).toBe(false);
  });
});

describe("stuckReason", () => {
  it("is null for a brand new or healthy device", () => {
    expect(stuckReason(dev(), 0, NOW)).toBeNull();
    expect(stuckReason(dev({ first_seen_at: ago(2), last_seen_at: ago(1) }), 0, NOW)).toBeNull();
    expect(stuckReason(dev({ first_seen_at: ago(60), first_job_at: ago(50), first_printed_at: ago(49) }), 0, NOW)).toBeNull();
  });
  it("flags an open issue", () => {
    expect(stuckReason(dev(), 1, NOW)).toBe("open_issue");
  });
  it("flags connected with no job after 10 minutes", () => {
    expect(stuckReason(dev({ first_seen_at: ago(11), last_seen_at: ago(1) }), 0, NOW)).toBe("connected_no_job");
    expect(STUCK_AFTER_MS).toBe(10 * 60_000);
  });
  it("flags a job not printed after 10 minutes", () => {
    expect(stuckReason(dev({ first_seen_at: ago(60), first_job_at: ago(11) }), 0, NOW)).toBe("job_not_printed");
    expect(stuckReason(dev({ first_seen_at: ago(60), first_job_at: ago(5) }), 0, NOW)).toBeNull();
  });
  it("never flags a revoked device", () => {
    expect(stuckReason(dev({ revoked_at: ago(1), first_seen_at: ago(60) }), 2, NOW)).toBeNull();
  });
});

describe("sortStuckFirst", () => {
  it("puts stuck devices first, then most recently seen, without mutating input", () => {
    const a = dev({ id: "a", last_seen_at: ago(5) });
    const b = dev({ id: "b", first_seen_at: ago(30), last_seen_at: ago(20) }); // stuck
    const c = dev({ id: "c", last_seen_at: ago(2) });
    const d = dev({ id: "d" }); // open issue
    const input = [a, b, c, d];
    const out = sortStuckFirst(input, { d: 1 }, NOW);
    expect(out.map((x) => x.id)).toEqual(["b", "d", "c", "a"]);
    expect(input.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("puts revoked devices last", () => {
    const r = dev({ id: "r", revoked_at: ago(1), last_seen_at: ago(0) });
    const a = dev({ id: "a" });
    expect(sortStuckFirst([r, a], {}, NOW).map((x) => x.id)).toEqual(["a", "r"]);
  });
});
