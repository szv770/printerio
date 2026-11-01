import { describe, expect, it } from "vitest";
import { finishingLabel } from "./finishing-label";

const job = (finishing: unknown, staple_position: string | null = null, booklet_binding_side: string | null = null) => ({ finishing, staple_position, booklet_binding_side });

describe("finishingLabel", () => {
  it("keeps the existing wording", () => {
    expect(finishingLabel(job({ staple: true }, "top-left"))).toBe("Stapled top-left");
    expect(finishingLabel(job({ staple: true }))).toBe("Stapled");
    expect(finishingLabel(job({ booklet: true }, null, "right"))).toBe("Booklet, bound on the right");
    expect(finishingLabel(job({}))).toBe("None");
  });
  it("two staples (left) and hole punch", () => {
    expect(finishingLabel(job({ staple: true, stapleStyle: "dual-left" }))).toBe("Two staples, left");
    expect(finishingLabel(job({ punch: true }))).toBe("Hole punch");
    expect(finishingLabel(job({ staple: true, punch: true }, "top-left"))).toBe("Stapled top-left, Hole punch");
  });
});
