import { describe, expect, it } from "vitest";
import { clampOptionsToCapabilities, type DeclaredCapabilities, type RequestedPrintOptions } from "./print-options";

const ALL: DeclaredCapabilities = { duplex: true, color: true, staple: true, booklet: true, punch: true };
const NONE: DeclaredCapabilities = { duplex: false, color: false, staple: false, booklet: false, punch: false };

function requested(overrides: Partial<RequestedPrintOptions> = {}): RequestedPrintOptions {
  return { colorMode: "bw", duplex: false, staple: false, booklet: false, punch: false, ...overrides };
}

describe("clampOptionsToCapabilities", () => {
  it("passes through everything a fully-capable profile declares", () => {
    const asked = requested({ colorMode: "color", duplex: true, staple: true, booklet: true, punch: true });
    expect(clampOptionsToCapabilities(asked, ALL)).toEqual(asked);
  });

  it("drops the form's own duplex default on a profile that doesn't declare duplex", () => {
    // The exact real case: PrintForm defaults duplex ON, and a booklet-only
    // queue declares no duplex - so the checkbox used to render checked while
    // the submitted FormData omitted it (disabled controls aren't submitted).
    const bookletOnly: DeclaredCapabilities = { ...NONE, booklet: true, staple: true };
    expect(clampOptionsToCapabilities(requested({ duplex: true, booklet: true }), bookletOnly)).toEqual(
      requested({ duplex: false, booklet: true }),
    );
  });

  it("falls back to black & white when color isn't declared", () => {
    expect(clampOptionsToCapabilities(requested({ colorMode: "color" }), NONE).colorMode).toBe("bw");
  });

  it("drops a finishing option carried over from a previously-selected profile", () => {
    const asked = requested({ staple: true, booklet: true, punch: true });
    expect(clampOptionsToCapabilities(asked, NONE)).toEqual(requested());
  });

  it("requests nothing when no profile is selected at all", () => {
    const asked = requested({ colorMode: "color", duplex: true, staple: true, booklet: true, punch: true });
    expect(clampOptionsToCapabilities(asked, null)).toEqual(requested());
  });

  it("never invents an option the user did not ask for", () => {
    expect(clampOptionsToCapabilities(requested(), ALL)).toEqual(requested());
  });
});
