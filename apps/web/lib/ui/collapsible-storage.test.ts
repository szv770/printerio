import { describe, expect, it } from "vitest";
import { openStateKey, readOpenState, resolveOpen, writeOpenState, type StorageLike } from "./collapsible-storage";

function memory(): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const throwing: StorageLike = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
};

describe("open-state storage", () => {
  it("round-trips per page and removes closed sections", () => {
    const s = memory();
    expect(writeOpenState(s, "/admin/settings", "stamp", true)).toBe(true);
    expect(writeOpenState(s, "/admin/settings", "signin", true)).toBe(true);
    expect(readOpenState(s, "/admin/settings")).toEqual({ stamp: true, signin: true });
    expect(readOpenState(s, "/admin/users")).toEqual({});
    writeOpenState(s, "/admin/settings", "stamp", false);
    expect(JSON.parse(s.data[openStateKey("/admin/settings")]!)).toEqual({ signin: true });
  });
  it("does not throw when localStorage throws, and reports the failed write", () => {
    expect(readOpenState(throwing, "/x")).toEqual({});
    expect(writeOpenState(throwing, "/x", "a", true)).toBe(false);
  });
  it("tolerates a missing storage object and corrupt data", () => {
    expect(readOpenState(null, "/x")).toEqual({});
    expect(writeOpenState(undefined, "/x", "a", true)).toBe(false);
    const s = memory();
    s.data[openStateKey("/x")] = "{not json";
    expect(readOpenState(s, "/x")).toEqual({});
    s.data[openStateKey("/x")] = "[1,2]";
    expect(readOpenState(s, "/x")).toEqual({});
  });
});

describe("resolveOpen", () => {
  const o = { id: "stamp", stored: {}, defaultOpen: false, forceOpen: false, hash: "" };
  it("is closed by default and uses defaultOpen", () => {
    expect(resolveOpen(o)).toBe(false);
    expect(resolveOpen({ ...o, defaultOpen: true })).toBe(true);
  });
  it("remembered open wins over default closed; remembered closed over default open", () => {
    expect(resolveOpen({ ...o, stored: { stamp: true } })).toBe(true);
    expect(resolveOpen({ ...o, defaultOpen: true, stored: { other: true } })).toBe(true);
  });
  it("hash match and forceOpen always open", () => {
    expect(resolveOpen({ ...o, hash: "#stamp" })).toBe(true);
    expect(resolveOpen({ ...o, hash: "#other" })).toBe(false);
    expect(resolveOpen({ ...o, forceOpen: true })).toBe(true);
  });
});
