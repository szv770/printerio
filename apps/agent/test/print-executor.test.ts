import { describe, expect, it } from "vitest";
import { buildPrintSettingsTokens, buildPrintSettingsString } from "../src/print-executor.js";
import { PrintExecutionError } from "../src/errors.js";

const baseInput = {
  colorMode: "bw" as const,
  duplex: true,
  paperSize: "letter",
  copies: 1,
  fitMode: "fit" as const,
  collateMultiCopy: true,
};

describe("buildPrintSettingsTokens", () => {
  it("emits only allow-listed tokens for a simple bw duplex job", () => {
    const tokens = buildPrintSettingsTokens(baseInput);
    expect(tokens).toEqual(["monochrome", "duplex", "fit", "paper=letter"]);
  });

  it("emits color/simplex correctly", () => {
    const tokens = buildPrintSettingsTokens({ ...baseInput, colorMode: "color", duplex: false });
    expect(tokens).toContain("color");
    expect(tokens).toContain("simplex");
  });

  it("adds copies (Nx) and collate only when copies > 1", () => {
    const single = buildPrintSettingsTokens({ ...baseInput, copies: 1 });
    expect(single.some((t) => /^[1-9][0-9]{0,2}x$/.test(t))).toBe(false);
    expect(single).not.toContain("collate");

    const multi = buildPrintSettingsTokens({ ...baseInput, copies: 5 });
    expect(multi).toContain("5x");
    expect(multi).toContain("collate");
  });

  it("respects collateMultiCopy=false", () => {
    const tokens = buildPrintSettingsTokens({ ...baseInput, copies: 3, collateMultiCopy: false });
    expect(tokens).toContain("3x");
    expect(tokens).not.toContain("collate");
  });

  it("rejects copies outside 1-999", () => {
    expect(() => buildPrintSettingsTokens({ ...baseInput, copies: 0 })).toThrow(PrintExecutionError);
    expect(() => buildPrintSettingsTokens({ ...baseInput, copies: 1000 })).toThrow(PrintExecutionError);
    expect(() => buildPrintSettingsTokens({ ...baseInput, copies: 1.5 })).toThrow(PrintExecutionError);
  });

  it("never emits a token containing shell/PowerShell metacharacters, regardless of a hostile paperSize", () => {
    const hostile = ['letter"; rm -rf /', "letter`whoami`", "letter$(id)", "letter' -Force", "letter\n-Force"];
    for (const paperSize of hostile) {
      expect(() => buildPrintSettingsTokens({ ...baseInput, paperSize })).toThrow(PrintExecutionError);
    }
  });

  it("accepts a plausible paper size like 11x17", () => {
    const tokens = buildPrintSettingsTokens({ ...baseInput, paperSize: "11x17" });
    expect(tokens).toContain("paper=11x17");
  });

  it("every produced token matches the documented allow-listed vocabulary exactly", () => {
    const allowList =
      /^(\d+(-\d+)?(,\d+(-\d+)?)*|color|monochrome|duplex|duplexshort|duplexlong|simplex|fit|shrink|noscale|collate|paper=[A-Za-z0-9_.-]+|bin=[A-Za-z0-9_.-]+|[1-9][0-9]{0,2}x)$/;
    const tokens = buildPrintSettingsTokens({ ...baseInput, copies: 4, paperSize: "a4" });
    for (const t of tokens) {
      expect(t).toMatch(allowList);
    }
  });

  it("builds a joined settings string", () => {
    const str = buildPrintSettingsString(baseInput);
    expect(str).toBe(buildPrintSettingsTokens(baseInput).join(","));
    expect(str).not.toContain(" ");
  });

  it("never includes staple/booklet/punch tokens - finishing is queue-selection only, not a print-settings concern", () => {
    const tokens = buildPrintSettingsTokens(baseInput);
    for (const t of tokens) {
      expect(t.toLowerCase()).not.toMatch(/staple|booklet|punch/);
    }
  });
});
