import { describe, expect, it } from "vitest";
import { devicePrinterLabel } from "./printer-label";

describe("devicePrinterLabel", () => {
  it("is Printio-<printer>-<user code>", () => {
    expect(devicePrinterLabel("MLMI", "SZV")).toBe("Printio-MLMI-SZV");
  });
  it("turns spaces and odd characters into single dashes, keeps letters and digits", () => {
    expect(devicePrinterLabel("MLM Office  Kyocera (8500)", "szv2")).toBe("Printio-MLM-Office-Kyocera-8500-SZV2");
  });
  it("drops the printer part when there is none, and the code part when there is none", () => {
    expect(devicePrinterLabel(null, "SZV")).toBe("Printio-SZV");
    expect(devicePrinterLabel("MLMI", null)).toBe("Printio-MLMI");
    expect(devicePrinterLabel(null, null)).toBe("Printio");
    expect(devicePrinterLabel("!!!", "")).toBe("Printio");
  });
  it("never exceeds 63 characters (an IPP name limit) and keeps the code when shortening", () => {
    const label = devicePrinterLabel("A".repeat(100), "SZV");
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label.endsWith("-SZV")).toBe(true);
    expect(label.startsWith("Printio-A")).toBe(true);
  });
});
