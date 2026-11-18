import { describe, expect, it } from "vitest";
import { putBuiltBooklet, takeBuiltBooklet } from "./handoff";

const file = () => new File([new Uint8Array([1])], "b.pdf", { type: "application/pdf" });

describe("booklet handoff", () => {
  it("hands the file over exactly once", () => {
    const f = file();
    putBuiltBooklet(f, 1000);
    expect(takeBuiltBooklet(2000)).toBe(f);
    expect(takeBuiltBooklet(2000)).toBeNull();
  });
  it("forgets a file that waited too long", () => {
    putBuiltBooklet(file(), 0);
    expect(takeBuiltBooklet(11 * 60 * 1000)).toBeNull();
  });
  it("is empty when nothing was put", () => {
    expect(takeBuiltBooklet()).toBeNull();
  });
});
