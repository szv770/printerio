import { describe, expect, it } from "vitest";
import { mergeSie, sieFromRow, sieToRow } from "./sie-store";
import type { SieEntry } from "./sie-weekly";

const entry = (over: Partial<SieEntry> = {}): SieEntry => ({
  chelek: "Alef",
  sefer: "Bereishis",
  title: "Noach",
  url: "https://drive.google.com/file/d/1CWNav1KEctok2nLBCgRWweEcWmNTC0ob/view",
  volume: 1,
  page: 4,
  from: 4,
  to: 15,
  pageCount: 18,
  ...over,
});

describe("SIE entries <-> database rows", () => {
  it("round-trips an entry with everything known", () => {
    expect(sieFromRow(sieToRow(entry()))).toEqual(entry());
  });
  it("round-trips an entry whose volume and page could not be read", () => {
    const e = entry({ volume: undefined, page: undefined });
    const row = sieToRow(e);
    expect(row.volume).toBeNull();
    expect(row.page).toBeNull();
    expect(sieFromRow(row)).toEqual({ chelek: "Alef", sefer: "Bereishis", title: "Noach", url: e.url, from: 4, to: 15, pageCount: 18 });
  });
  it("writes the column names the table uses", () => {
    expect(Object.keys(sieToRow(entry())).sort()).toEqual(["chelek", "from_page", "page", "page_count", "sefer", "title", "to_page", "url", "volume"]);
  });
});

describe("mergeSie (the saved copy plus what an admin added)", () => {
  it("lists the saved weeks first, then the new ones, and never the same file twice", () => {
    const a = entry({ url: "https://drive.google.com/file/d/AAAAAAAAAAAAAAAAAAAAAAAAA/view", title: "A" });
    const b = entry({ url: "https://drive.google.com/file/d/BBBBBBBBBBBBBBBBBBBBBBBBB/view", title: "B" });
    const dup = entry({ url: a.url, title: "A again" });
    expect(mergeSie([a], [b, dup]).map((e) => e.title)).toEqual(["A", "B"]);
    expect(mergeSie([a], [])).toEqual([a]);
  });
});
