import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Modal, MODAL_Z, nextTrapIndex } from "./Modal";

describe("Modal", () => {
  it("renders nothing on the server (the portal only exists after mount)", () => {
    expect(renderToStaticMarkup(<Modal open onClose={() => {}} title="Help">body</Modal>)).toBe("");
  });

  it("sits above the member tab bar (z-60) and the admin drawer (z-50)", () => {
    expect(MODAL_Z).toBe("z-[100]");
  });
});

describe("focus trap", () => {
  it("wraps forwards from the last item and backwards from the first", () => {
    expect(nextTrapIndex(2, 3, false)).toBe(0);
    expect(nextTrapIndex(0, 3, true)).toBe(2);
  });
  it("lets the browser move focus inside the dialog", () => {
    expect(nextTrapIndex(1, 3, false)).toBe(-1);
    expect(nextTrapIndex(1, 3, true)).toBe(-1);
  });
  it("pulls focus in from outside the list", () => {
    expect(nextTrapIndex(-1, 3, false)).toBe(0);
    expect(nextTrapIndex(-1, 3, true)).toBe(2);
    expect(nextTrapIndex(0, 0, false)).toBe(-1);
  });
});
