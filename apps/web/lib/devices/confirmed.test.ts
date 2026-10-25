import { describe, expect, it } from "vitest";
import { CONFIRMED_DEVICE_TYPES, STILL_TESTING_DEVICE_TYPES, confirmedBannerText, joinWords } from "./confirmed";

describe("joinWords", () => {
  it("reads naturally", () => {
    expect(joinWords(["Windows"])).toBe("Windows");
    expect(joinWords(["Windows", "Android"])).toBe("Windows and Android");
    expect(joinWords(["Windows", "iPhone", "Android"])).toBe("Windows, iPhone and Android");
    expect(joinWords([])).toBe("");
  });
});

describe("confirmedBannerText", () => {
  it("says what is confirmed on real devices and what is still being tested", () => {
    const t = confirmedBannerText();
    expect(t.headline).toBe("Printing is confirmed working on Windows, iPhone and Android.");
    expect(t.detail).toBe("Mac and Chromebook are still being tested.");
  });
  it("a device type is never both confirmed and still testing", () => {
    for (const c of CONFIRMED_DEVICE_TYPES) expect(STILL_TESTING_DEVICE_TYPES).not.toContain(c);
  });
  it("leaves out the second sentence when nothing is left to test", () => {
    expect(confirmedBannerText({ confirmed: ["windows"], testing: [] }).detail).toBeNull();
  });
});
