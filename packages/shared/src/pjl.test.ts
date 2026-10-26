import { describe, expect, it } from "vitest";
import { buildPjlSettings, buildRawJob, sanitizePjlText } from "./pjl";

const base = { copies: 1, colorMode: "color" as const, duplex: true, jobName: "Quiz 3" };

describe("buildPjlSettings: 11x17 (ledger) paper", () => {
  const booklet = { ...base, booklet: true, bindingSide: "left" as const };
  it("a ledger booklet adds PAPER=LEDGER after the proven booklet settings (proven by a real print, 2026-10-26)", () => {
    const r = buildPjlSettings({ ...booklet, paper: "ledger" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.settings.slice(0, 5)).toEqual(["DUPLEX=ON", "BINDING=SHORTEDGE", "OUTBIN=KBOOKLET", "FINISH=KFOLD", "PAPER=LEDGER"]);
  });
  it("a plain ledger job also gets PAPER=LEDGER, and a normal job never does", () => {
    const plain = buildPjlSettings({ ...base, duplex: true, duplexEdge: "short", paper: "ledger" });
    if (!plain.ok) throw new Error(plain.reason);
    expect(plain.settings).toContain("PAPER=LEDGER");
    for (const o of [{ ...base }, { ...booklet }, { ...base, paper: undefined }]) {
      const r = buildPjlSettings(o);
      if (!r.ok) throw new Error(r.reason);
      expect(r.settings.join(" ")).not.toMatch(/PAPER/);
    }
  });
});

describe("buildPjlSettings", () => {
  it("one-sided", () => {
    const r = buildPjlSettings({ ...base, duplex: false });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.settings).toContain("DUPLEX=OFF");
  });

  it("duplex long edge by default", () => {
    const r = buildPjlSettings(base);
    if (!r.ok) throw new Error(r.reason);
    expect(r.settings).toEqual(expect.arrayContaining(["DUPLEX=ON", "BINDING=LONGEDGE", "QTY=1"]));
  });

  it("duplex short edge sends BINDING=SHORTEDGE (plain documents, not only booklets)", () => {
    const r = buildPjlSettings({ ...base, duplex: true, duplexEdge: "short" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.settings).toEqual(expect.arrayContaining(["DUPLEX=ON", "BINDING=SHORTEDGE", "QTY=1"]));
    expect(r.settings).not.toContain("BINDING=LONGEDGE");
  });

  it("an explicit long edge, or no edge, stays long edge; single-sided ignores the edge", () => {
    for (const duplexEdge of ["long", undefined] as const) {
      const r = buildPjlSettings({ ...base, duplex: true, duplexEdge });
      if (!r.ok) throw new Error(r.reason);
      expect(r.settings).toContain("BINDING=LONGEDGE");
    }
    const one = buildPjlSettings({ ...base, duplex: false, duplexEdge: "short" });
    if (!one.ok) throw new Error(one.reason);
    expect(one.settings).toContain("DUPLEX=OFF");
    expect(one.settings.join()).not.toContain("BINDING");
  });

  it("short edge together with a staple is refused (the corner is not known for that combination)", () => {
    const r = buildPjlSettings({ ...base, duplex: true, duplexEdge: "short", staple: "top-left" });
    expect(r.ok).toBe(false);
  });

  it("copies map to QTY", () => {
    const r = buildPjlSettings({ ...base, copies: 7 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.settings).toContain("QTY=7");
  });

  it("never sends a colour setting until KCOLORMODE=MONO is verified on the printer", () => {
    // Unverified (see docs/kyocera-raw-print.md); staff prints must keep the printer's default.
    for (const colorMode of ["bw", "color"] as const) {
      const r = buildPjlSettings({ ...base, colorMode });
      if (!r.ok) throw new Error(r.reason);
      expect(r.settings.join()).not.toContain("KCOLORMODE");
    }
  });

  it("staple maps match the real-printer results (2026-10-19)", () => {
    // top-left: ONE. top-right: ONE + KFEEDEDGE=SHORTEDGE (job P1). bottom-left: ONEOPPOSED.
    const get = (staple: "top-left" | "top-right" | "bottom-left") => {
      const r = buildPjlSettings({ ...base, staple });
      if (!r.ok) throw new Error(r.reason);
      return r.settings;
    };
    const tl = get("top-left");
    const tr = get("top-right");
    const bl = get("bottom-left");
    for (const s of [tl, tr, bl]) {
      expect(s).toEqual(expect.arrayContaining(["DUPLEX=ON", "BINDING=LONGEDGE", "OUTBIN=OPTIONFACEDOWN", "FINISH=STAPLE"]));
    }
    expect(tl).toContain("STAPLEOPTION=ONE");
    expect(tl.join()).not.toContain("KFEEDEDGE");
    expect(tr).toEqual(expect.arrayContaining(["STAPLEOPTION=ONE", "KFEEDEDGE=SHORTEDGE"]));
    expect(bl).toContain("STAPLEOPTION=ONEOPPOSED");
    expect(bl.join()).not.toContain("KFEEDEDGE");
  });

  it("left-binding booklet uses the proven KBOOKLET + KFOLD recipe", () => {
    const r = buildPjlSettings({ ...base, booklet: true, bindingSide: "left" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.settings).toEqual(
      expect.arrayContaining(["DUPLEX=ON", "BINDING=SHORTEDGE", "OUTBIN=KBOOKLET", "FINISH=KFOLD"]),
    );
    expect(r.settings).not.toContain("BINDING=LONGEDGE");
    expect(r.settings.join()).not.toContain("KREVERSEFOLD");
  });

  it("right-binding booklet uses the same fold as left (the layout carries the side)", () => {
    // Confirmed 2026-10-19 (job F1): mirrored (right) imposition + KFOLD + SHORTEDGE
    // gives a perfect right-to-left booklet; KREVERSEFOLD scrambled it.
    const l = buildPjlSettings({ ...base, booklet: true, bindingSide: "left" });
    const r = buildPjlSettings({ ...base, booklet: true, bindingSide: "right" });
    if (!l.ok || !r.ok) throw new Error("expected ok");
    expect(r.settings).toEqual(l.settings);
    expect(r.settings.join()).not.toContain("KREVERSEFOLD");
  });

  it("booklet without a binding side is held", () => {
    expect(buildPjlSettings({ ...base, booklet: true }).ok).toBe(false);
  });

  it("booklet + staple together is held", () => {
    const r = buildPjlSettings({ ...base, booklet: true, bindingSide: "left", staple: "top-left" });
    expect(r.ok).toBe(false);
  });

  it("rejects bad copies", () => {
    expect(buildPjlSettings({ ...base, copies: 0 }).ok).toBe(false);
    expect(buildPjlSettings({ ...base, copies: 1.5 }).ok).toBe(false);
  });
});

describe("sanitizePjlText", () => {
  it("strips quotes, newlines, escapes and limits length", () => {
    const s = sanitizePjlText('a"b\r\n@PJL SET X=1\x1b%-12345X' + "z".repeat(200));
    expect(s).not.toMatch(/["\r\n\x1b]/);
    expect(s.length).toBeLessThanOrEqual(60);
  });
  it("falls back for empty", () => {
    expect(sanitizePjlText("\r\n")).toBe("printio");
  });
});

describe("buildRawJob", () => {
  const dec = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
  it("frames: UEL, PJL header, ENTER LANGUAGE=PDF, pdf bytes, EOJ, UEL", () => {
    const pdf = new TextEncoder().encode("%PDF-1.4\nBODY\n%%EOF");
    const r = buildRawJob(base, pdf);
    if (!r.ok) throw new Error(r.reason);
    const s = dec(r.bytes);
    expect(s.startsWith("\x1b%-12345X@PJL\r\n")).toBe(true);
    expect(s).toContain('@PJL JOB NAME="Quiz 3"');
    expect(s).toContain("@PJL SET DUPLEX=ON\r\n");
    expect(s).toContain("@PJL ENTER LANGUAGE=PDF\r\n%PDF-1.4");
    expect(s.endsWith("\x1b%-12345X@PJL EOJ NAME=\"Quiz 3\"\r\n\x1b%-12345X")).toBe(true);
  });
  it("propagates a hold", () => {
    const r = buildRawJob({ ...base, copies: 0 }, new Uint8Array([1]));
    expect(r.ok).toBe(false);
  });
});
