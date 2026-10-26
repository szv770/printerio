import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// next/font only works inside a Next build; the page only needs its CSS variable name.
vi.mock("./landing-font", () => ({ displayFont: { variable: "font-display-test" } }));

import { Landing } from "./Landing";
import { CONFIRMED_DEVICE_TYPES, STILL_TESTING_DEVICE_TYPES } from "@/lib/devices/confirmed";
import { COMING_NEXT, FEATURE_ROWS, landingDevices } from "@/lib/landing-content";

const html = renderToStaticMarkup(<Landing />);

describe("public home page", () => {
  it("says what Printio is and gives visitors a way in", () => {
    expect(html).toContain("Press Print. It comes out of the right printer.");
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/join"');
    expect(html).toContain("<main");
  });

  it("shows the interactive demo and the booklet fold", () => {
    expect(html).toContain('role="tablist"');
    expect(html).toContain("Printio-MLMI-SZV");
    expect(html).toContain("Hebrew, right edge");
    expect(html).toContain("Fold it");
  });

  it("lists exactly the devices from the confirmed list, no more", () => {
    const devices = landingDevices();
    expect(devices.filter((d) => d.confirmed)).toHaveLength(CONFIRMED_DEVICE_TYPES.length);
    expect(devices.filter((d) => !d.confirmed)).toHaveLength(STILL_TESTING_DEVICE_TYPES.length);
    for (const d of devices) expect(html).toContain(d.name);
    expect(html).toContain("confirmed on a real device");
  });

  it("marks everything that is not yet proven on paper, and keeps coming-soon items out of the feature list", () => {
    const testing = FEATURE_ROWS.filter((r) => r.testing);
    expect(testing.length).toBeGreaterThan(0);
    expect(html).toContain("still testing");
    for (const c of COMING_NEXT) for (const r of FEATURE_ROWS) expect(r.title).not.toBe(c);
  });

  it("does not make claims it cannot back up", () => {
    const text = html.replace(/<[^>]+>/g, " "); // what a visitor reads, not class names
    for (const phrase of [/thousands/i, /millions/i, /trusted by/i, /\d+%/, /award/i, /number one|#1/i, /best[- ]in[- ]class/i]) expect(text).not.toMatch(phrase);
  });

  it("every feature has plain wording (no empty titles or details)", () => {
    for (const r of FEATURE_ROWS) {
      expect(r.title.length).toBeGreaterThan(3);
      expect(r.detail.length).toBeGreaterThan(20);
    }
  });
});
