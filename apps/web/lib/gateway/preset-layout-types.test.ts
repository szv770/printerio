import { describe, expect, it } from "vitest";
import type { LayoutSpec } from "@printio/pdf/nup";
import { PRINT_PRESETS, type PresetLayout } from "@printio/shared";

describe("PresetLayout mirrors packages/pdf LayoutSpec", () => {
  it("is assignable to LayoutSpec (a type-level check; typecheck fails if they drift)", () => {
    const check = (l: PresetLayout): LayoutSpec => l;
    for (const p of PRINT_PRESETS) if (p.layout) expect(check(p.layout).kind).toBe(p.layout.kind);
  });
});
