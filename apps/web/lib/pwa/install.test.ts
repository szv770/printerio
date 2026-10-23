import { describe, expect, it } from "vitest";
import { installCardMode, isIosDevice } from "./install";

const base = { standalone: false, dismissed: false, ios: false, promptAvailable: false };

describe("installCardMode", () => {
  it("shows the install button when the browser offered an install prompt", () => {
    expect(installCardMode({ ...base, promptAvailable: true })).toBe("prompt");
  });
  it("shows nothing when there is no prompt and it is not iOS (nothing to offer)", () => {
    expect(installCardMode(base)).toBe("hidden");
  });
  it("shows the Add to Home Screen hint on iOS", () => {
    expect(installCardMode({ ...base, ios: true })).toBe("ios");
  });
  it("is hidden when already running as an installed app", () => {
    expect(installCardMode({ ...base, promptAvailable: true, standalone: true })).toBe("hidden");
    expect(installCardMode({ ...base, ios: true, standalone: true })).toBe("hidden");
  });
  it("is hidden after the user dismissed it", () => {
    expect(installCardMode({ ...base, promptAvailable: true, dismissed: true })).toBe("hidden");
    expect(installCardMode({ ...base, ios: true, dismissed: true })).toBe("hidden");
  });
  it("menu rows ignore an earlier dismissal but still hide when installed", () => {
    expect(installCardMode({ ...base, promptAvailable: true, dismissed: true }, { ignoreDismissed: true })).toBe("prompt");
    expect(installCardMode({ ...base, promptAvailable: true, standalone: true, dismissed: true }, { ignoreDismissed: true })).toBe("hidden");
  });
});

describe("isIosDevice", () => {
  it("recognises iPhone and iPad", () => {
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1", platform: "iPhone", maxTouchPoints: 5 })).toBe(true);
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", platform: "iPad", maxTouchPoints: 5 })).toBe(true);
  });
  it("recognises iPadOS pretending to be a Mac", () => {
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
  });
  it("does not match a real Mac, Android or Windows", () => {
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) Chrome/130", platform: "Linux armv8l", maxTouchPoints: 5 })).toBe(false);
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130", platform: "Win32", maxTouchPoints: 0 })).toBe(false);
  });
});
