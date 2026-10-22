import { describe, expect, it } from "vitest";
import { commitKeys, dirtyKeys, isDirty, valuesEqual } from "./dirty";

describe("valuesEqual", () => {
  it("compares primitives, arrays and plain objects deeply", () => {
    expect(valuesEqual(1, 1)).toBe(true);
    expect(valuesEqual("a", "b")).toBe(false);
    expect(valuesEqual([1, 2], [1, 2])).toBe(true);
    expect(valuesEqual([1, 2], [2, 1])).toBe(false);
    expect(valuesEqual({ a: [1], b: "x" }, { b: "x", a: [1] })).toBe(true);
    expect(valuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
  it("treats null and undefined as the same empty value, but not 0 or ''", () => {
    expect(valuesEqual(null, undefined)).toBe(true);
    expect(valuesEqual(null, "")).toBe(false);
    expect(valuesEqual(0, false)).toBe(false);
  });
  it("normalises line endings only", () => {
    expect(valuesEqual("a\r\nb", "a\nb")).toBe(true);
    expect(valuesEqual("a ", "a")).toBe(false);
  });
});

describe("dirtyKeys / isDirty", () => {
  const initial = { name: "A", on: true, tags: ["x"] };
  it("is clean for equal values", () => {
    expect(isDirty(initial, { name: "A", on: true, tags: ["x"] })).toBe(false);
  });
  it("lists changed keys, and a change reverted by hand is clean again", () => {
    const cur = { ...initial, name: "B", tags: ["x", "y"] };
    expect(dirtyKeys(initial, cur)).toEqual(["name", "tags"]);
    expect(isDirty(initial, { ...cur, name: "A", tags: ["x"] })).toBe(false);
  });
});

describe("commitKeys", () => {
  it("moves only the saved keys into the baseline", () => {
    const cur = { name: "B", on: false, tags: ["x"] };
    const next = commitKeys({ name: "A", on: true, tags: ["x"] }, cur, ["name"]);
    expect(next).toEqual({ name: "B", on: true, tags: ["x"] });
    expect(dirtyKeys(next, cur)).toEqual(["on"]);
  });
});
