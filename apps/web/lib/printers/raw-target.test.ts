import { describe, expect, it } from "vitest";
import { isValidRawHost, parseRawPort, parseOutputTarget, rawTargetFromProfile } from "./raw-target";

describe("isValidRawHost", () => {
  it.each(["192.168.1.50", "10.0.0.1", "printer.local", "kyocera-1", "my.host.example.com"])("accepts %s", (h) => {
    expect(isValidRawHost(h)).toBe(true);
  });
  it.each(["", " ", "999.1.1.1", "1.2.3", "-bad", "bad-", "a b", "http://x", "x:9100", "a..b", "1.2.3.4.5", "a".repeat(254)])(
    "rejects %j",
    (h) => {
      expect(isValidRawHost(h)).toBe(false);
    },
  );
});

describe("parseRawPort", () => {
  it("defaults empty to 9100", () => expect(parseRawPort("")).toEqual({ ok: true, port: 9100 }));
  it("accepts 1..65535", () => {
    expect(parseRawPort("1")).toEqual({ ok: true, port: 1 });
    expect(parseRawPort("65535")).toEqual({ ok: true, port: 65535 });
  });
  it.each(["0", "65536", "-1", "9100.5", "abc", "91 00"])("rejects %s", (v) => {
    expect(parseRawPort(v).ok).toBe(false);
  });
});

describe("parseOutputTarget", () => {
  it("queue mode requires a queue name and ignores raw fields", () => {
    expect(parseOutputTarget({ outputMode: "queue", windowsQueueName: " Q1 ", rawHost: "", rawPort: "", rawStaplePosition: "" })).toEqual({
      ok: true,
      value: { outputMode: "queue", windowsQueueName: "Q1", rawHost: null, rawPort: 9100, rawStaplePosition: "top-left" },
    });
    expect(parseOutputTarget({ outputMode: "queue", windowsQueueName: " ", rawHost: "1.2.3.4" }).ok).toBe(false);
  });
  it("raw mode requires a valid host, no queue name", () => {
    expect(
      parseOutputTarget({ outputMode: "raw", windowsQueueName: "ignored", rawHost: "192.168.1.5", rawPort: "9101", rawStaplePosition: "top-right" }),
    ).toEqual({
      ok: true,
      value: { outputMode: "raw", windowsQueueName: null, rawHost: "192.168.1.5", rawPort: 9101, rawStaplePosition: "top-right" },
    });
    expect(parseOutputTarget({ outputMode: "raw", rawHost: "" }).ok).toBe(false);
    expect(parseOutputTarget({ outputMode: "raw", rawHost: "not valid" }).ok).toBe(false);
    expect(parseOutputTarget({ outputMode: "raw", rawHost: "1.2.3.4", rawPort: "0" }).ok).toBe(false);
  });
  it("defaults to queue mode and falls back to top-left for unknown staple position", () => {
    const r = parseOutputTarget({ windowsQueueName: "Q" });
    expect(r.ok && r.value.outputMode).toBe("queue");
    const raw = parseOutputTarget({ outputMode: "raw", rawHost: "h1", rawStaplePosition: "bogus" });
    expect(raw.ok && raw.value.rawStaplePosition).toBe("top-left");
  });
});

describe("rawTargetFromProfile", () => {
  const base = { output_mode: "raw", raw_host: "10.0.0.9", raw_port: 9100, raw_staple_position: "top-right", booklet_binding_side: "left" };
  it("maps a raw profile", () => {
    expect(rawTargetFromProfile(base, { jobTitle: "Quarterly report" })).toEqual({
      host: "10.0.0.9",
      port: 9100,
      staplePosition: "top-right",
      bindingSide: "left",
      jobName: "Quarterly report",
    });
  });
  it("uses a job binding override and sanitizes/shortens the job name", () => {
    const r = rawTargetFromProfile(base, { jobTitle: 'bad"\r\n@PJL SET x\u0007' + "z".repeat(100), bindingSide: "right" });
    expect(r?.bindingSide).toBe("right");
    expect(r?.jobName).not.toMatch(/["\r\n\u0007@]/);
    expect(r!.jobName.length).toBeLessThanOrEqual(60);
  });
  it("falls back to 'Printio job'", () => {
    expect(rawTargetFromProfile(base, { jobTitle: "  " })?.jobName).toBe("Printio job");
    expect(rawTargetFromProfile(base, {})?.jobName).toBe("Printio job");
  });
  it("returns undefined for queue profiles or raw without host", () => {
    expect(rawTargetFromProfile({ ...base, output_mode: "queue" }, {})).toBeUndefined();
    expect(rawTargetFromProfile({ ...base, raw_host: null }, {})).toBeUndefined();
  });
});

describe("rawTargetFromProfile per-job staple corner", () => {
  const base = { output_mode: "raw", raw_host: "10.0.0.9", raw_port: 9100, raw_staple_position: "top-right", booklet_binding_side: "left" };
  it("uses the job's staple position, else the printer's default", () => {
    expect(rawTargetFromProfile(base, { staplePosition: "top-left" })?.staplePosition).toBe("top-left");
    expect(rawTargetFromProfile(base, { staplePosition: null })?.staplePosition).toBe("top-right");
    expect(rawTargetFromProfile(base, {})?.staplePosition).toBe("top-right");
  });
});

describe("sender code in the job name (so the printer panel shows whose job it is)", () => {
  const base = { output_mode: "raw", raw_host: "192.168.1.5", raw_port: 9100, raw_staple_position: "top-left", booklet_binding_side: "left" };
  it("puts Printio-<code> in front of the file name", () => {
    expect(rawTargetFromProfile(base, { jobTitle: "Quarterly report.pdf", senderCode: "SZV" })?.jobName).toBe("Printio-SZV Quarterly report.pdf");
  });
  it("keeps the code and shortens the title when the whole name is too long (60 characters max)", () => {
    const name = rawTargetFromProfile(base, { jobTitle: "x".repeat(100), senderCode: "SZV" })!.jobName;
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.startsWith("Printio-SZV x")).toBe(true);
  });
  it("cleans an odd code and ignores a missing or empty one (old behaviour)", () => {
    expect(rawTargetFromProfile(base, { jobTitle: "A", senderCode: 'S"Z\r\nV' })?.jobName).toBe("Printio-SZV A");
    expect(rawTargetFromProfile(base, { jobTitle: "A", senderCode: "" })?.jobName).toBe("A");
    expect(rawTargetFromProfile(base, { jobTitle: "A", senderCode: null })?.jobName).toBe("A");
    expect(rawTargetFromProfile(base, { jobTitle: "A" })?.jobName).toBe("A");
  });
  it("uses just Printio-<code> when there is no title", () => {
    expect(rawTargetFromProfile(base, { senderCode: "SZV" })?.jobName).toBe("Printio-SZV Printio job");
  });
});

describe("duplex edge on the raw target", () => {
  const base = { output_mode: "raw", raw_host: "192.168.1.5", raw_port: 9100, raw_staple_position: "top-left", booklet_binding_side: "left" };
  it("carries a short-edge flip to the Agent, and nothing for the usual long edge", () => {
    expect(rawTargetFromProfile(base, { jobTitle: "A", duplexEdge: "short" })?.duplexEdge).toBe("short");
    expect(rawTargetFromProfile(base, { jobTitle: "A" })).not.toHaveProperty("duplexEdge");
    expect(rawTargetFromProfile(base, { jobTitle: "A", duplexEdge: null })).not.toHaveProperty("duplexEdge");
  });
});
