import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEntryPage, parseLikkutSichos, parseListPage } from "@printio/shared/library/mafteiach-parse";
import { checkPayload, MAX_PAYLOAD_BYTES } from "./payload-schema";

// The real (trimmed) pages the parsers are tested against: whatever they produce must be accepted, or the cache would
// refuse genuine results.
const fixture = (name: string) => readFileSync(join(__dirname, "../../../../packages/shared/src/library/fixtures", name), "utf8");

const likkut = { kind: "likkutei", volume: 1 } as const;
const list = { kind: "list", section: "maamorim" } as const;
const entry = { kind: "entry", path: "/maamorim/1" } as const;

describe("checkPayload accepts what the real parsers produce", () => {
  it("Likkutei Sichos volume", () => expect(checkPayload(likkut, parseLikkutSichos(fixture("likkutei-volume.html"))).ok).toBe(true));
  it("maamorim list", () => expect(checkPayload(list, parseListPage(fixture("maamorim-list.html"))).ok).toBe(true));
  it("maamor entry and farbrengen entry", () => {
    expect(checkPayload(entry, parseEntryPage(fixture("maamor-entry.html"))).ok).toBe(true);
    expect(checkPayload(entry, parseEntryPage(fixture("farbrengen-entry.html"))).ok).toBe(true);
  });
  it("returns the validated copy", () => {
    const page = parseLikkutSichos(fixture("likkutei-volume.html"));
    const r = checkPayload(likkut, page);
    expect(r.ok && r.payload).toEqual(page);
  });
});

describe("checkPayload refuses", () => {
  const goodList = parseListPage(fixture("maamorim-list.html"));
  const goodEntry = parseEntryPage(fixture("maamor-entry.html"));

  it("the wrong kind of payload for the job (a list sent for a Likkutei job, and the reverse)", () => {
    expect(checkPayload(likkut, goodList)).toMatchObject({ ok: false, code: "invalid" });
    expect(checkPayload(list, parseLikkutSichos(fixture("likkutei-volume.html")))).toMatchObject({ ok: false, code: "invalid" });
    expect(checkPayload(entry, goodList)).toMatchObject({ ok: false, code: "invalid" });
  });

  it("junk, extra fields and wrong types", () => {
    expect(checkPayload(list, "hello")).toMatchObject({ ok: false, code: "invalid" });
    expect(checkPayload(list, null)).toMatchObject({ ok: false, code: "invalid" });
    expect(checkPayload(list, { ...goodList, extra: 1 })).toMatchObject({ ok: false, code: "invalid" });
    expect(checkPayload(list, { years: "x", entries: [] })).toMatchObject({ ok: false, code: "invalid" });
    expect(checkPayload(entry, { sections: [] })).toMatchObject({ ok: false, code: "invalid" });
  });

  it("a link that is not an https Google Drive or Docs file", () => {
    const withUrl = (url: string) => [{ title: "t", groups: [{ label: "", links: [{ label: "l", url }] }] }];
    expect(checkPayload(entry, withUrl("https://drive.google.com/file/d/abc/view")).ok).toBe(true);
    for (const url of ["http://drive.google.com/x", "https://evil.example/x", "javascript:alert(1)", "https://drive.google.com.evil.example/x", "/relative"]) {
      expect(checkPayload(entry, withUrl(url)), url).toMatchObject({ ok: false, code: "invalid" });
    }
  });

  it("strings and lists over the limits", () => {
    const e = goodList.entries[0]!;
    expect(checkPayload(list, { ...goodList, entries: [{ ...e, title: "x".repeat(1001) }] })).toMatchObject({ ok: false });
    expect(checkPayload(list, { ...goodList, entries: Array.from({ length: 6001 }, () => e) })).toMatchObject({ ok: false });
    expect(checkPayload(entry, Array.from({ length: 101 }, () => goodEntry[0]!))).toMatchObject({ ok: false });
  });

  it("an entry path that is not one of the allowed shapes", () => {
    const e = goodList.entries[0]!;
    expect(checkPayload(list, { ...goodList, entries: [{ ...e, path: "https://evil.example/x" }] })).toMatchObject({ ok: false });
    expect(checkPayload(list, { ...goodList, entries: [{ ...e, path: "/other/1" }] })).toMatchObject({ ok: false });
  });

  it("a payload over the size limit, even when every field is within its own limit", () => {
    const section = { title: "t", groups: Array.from({ length: 100 }, () => ({ label: "x".repeat(500), links: [] })) };
    const many = Array.from({ length: 100 }, () => section); // valid by the schema, about 5 MB
    expect(checkPayload(entry, many)).toMatchObject({ ok: false, code: "too_large" });
    expect(checkPayload(list, { years: [], entries: [], pad: "x".repeat(MAX_PAYLOAD_BYTES) })).toMatchObject({ ok: false, code: "too_large" });
  });

  it("an empty Likkutei volume or an empty list (the 'page looks different today' case); an empty entry is fine as today", () => {
    expect(checkPayload(likkut, { volumes: [], current: null, parshiyos: [] })).toMatchObject({ ok: false, code: "empty" });
    expect(checkPayload(list, { years: [], entries: [] })).toMatchObject({ ok: false, code: "empty" });
    expect(checkPayload(entry, []).ok).toBe(true);
  });
});
