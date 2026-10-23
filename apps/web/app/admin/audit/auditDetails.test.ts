import { describe, expect, it } from "vitest";
import { detailsToggleLabel } from "./detailsToggle";

describe("detailsToggleLabel", () => {
  it("offers to show when closed and to hide when open", () => {
    expect(detailsToggleLabel(false)).toBe("Show details");
    expect(detailsToggleLabel(true)).toBe("Hide details");
  });
});
