import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
vi.mock("server-only", () => ({}));
import { PDFDocument } from "pdf-lib";
import { assembleBooklet, BuilderError, MAX_SOURCES, type BuilderInput } from "./assemble";

/** A PDF whose pages each have a distinct width, so the order of copied pages can be read back from the result. */
async function pdf(widths: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const w of widths) doc.addPage([w, 700]);
  return doc.save();
}

const widthsOf = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPages().map((p) => Math.round(p.getWidth()));

async function input(over: Partial<BuilderInput> = {}): Promise<BuilderInput> {
  return {
    title: "Parshas Vayera",
    description: "Selected sichos",
    direction: "ltr",
    cover: true,
    contents: true,
    sources: [
      { title: "First sicha", bytes: await pdf([301, 302, 303, 304]), pages: [2, 3] },
      { title: "Second sicha", bytes: await pdf([401, 402]), pages: [1, 2] },
    ],
    ...over,
  };
}

describe("assembleBooklet", () => {
  it("makes a cover, a contents page, then the chosen pages of each source in order", async () => {
    const r = await assembleBooklet(await input());
    expect(r.pageCount).toBe(2 + 2 + 2); // cover + contents + 2 + 2 pages
    const widths = await widthsOf(r.bytes);
    expect(widths.slice(2)).toEqual([302, 303, 401, 402]); // pages 2-3 of the first, then both of the second
    // the front pages take the size of the first page that is in the booklet
    expect(widths.slice(0, 2)).toEqual([302, 302]);
  });

  it("works out where each source starts, counting the cover and contents pages", async () => {
    const r = await assembleBooklet(await input());
    expect(r.entries).toEqual([
      { title: "First sicha", startPage: 3 },
      { title: "Second sicha", startPage: 5 },
    ]);
  });

  it("numbers differently when the cover or contents are switched off", async () => {
    const noCover = await assembleBooklet(await input({ cover: false }));
    expect(noCover.entries.map((e) => e.startPage)).toEqual([2, 4]);
    const neither = await assembleBooklet(await input({ cover: false, contents: false }));
    expect(neither.pageCount).toBe(4);
    expect(neither.entries.map((e) => e.startPage)).toEqual([1, 3]);
    const onlyCover = await assembleBooklet(await input({ contents: false }));
    expect(onlyCover.entries.map((e) => e.startPage)).toEqual([2, 4]);
  });

  it("keeps the order the person chose within a source, and can take pages from the same source twice in order", async () => {
    const r = await assembleBooklet(await input({ cover: false, contents: false, sources: [{ title: "A", bytes: await pdf([101, 102, 103]), pages: [3, 1, 2] }] }));
    expect(await widthsOf(r.bytes)).toEqual([103, 101, 102]);
  });

  it("uses a placeholder title for an untitled file", async () => {
    const r = await assembleBooklet(await input({ sources: [{ title: "  ", bytes: await pdf([300]), pages: [1] }] }));
    expect(r.entries[0]!.title).toBe("File 1");
  });

  it("builds a Hebrew booklet too (the layout mirrors, the pages are the same)", async () => {
    const r = await assembleBooklet(await input({ title: "ליקוטי שיחות - פרשת וירא", description: "מקבץ שיחות", direction: "rtl", sources: [{ title: "שיחה א", bytes: await pdf([300, 301]), pages: [1, 2], credit: "Mafteiach (mafteiach.app)" }] }));
    expect(r.pageCount).toBe(4);
    expect(r.entries).toEqual([{ title: "שיחה א", startPage: 3 }]);
  });

  it("carries pages only: no outline, scripts or attachments come across", async () => {
    const r = await assembleBooklet(await input());
    const doc = await PDFDocument.load(r.bytes);
    expect(doc.getTitle()).toBe("Parshas Vayera");
    expect(doc.context.lookup(doc.catalog.get(doc.context.obj("Names")) as never)).toBeUndefined();
  });

  describe("refuses, in plain words", () => {
    const bad = async (over: Partial<BuilderInput>, why: RegExp) => {
      await expect(assembleBooklet(await input(over))).rejects.toThrow(why);
      await expect(assembleBooklet(await input(over))).rejects.toBeInstanceOf(BuilderError);
    };
    it("a missing name, too long a name or description", async () => {
      await bad({ title: "   " }, /name/i);
      await bad({ title: "x".repeat(200) }, /too long/i);
      await bad({ description: "x".repeat(700) }, /too long/i);
    });
    it("no files, or too many", async () => {
      await bad({ sources: [] }, /at least one file/i);
      const one = { title: "A", bytes: await pdf([300]), pages: [1] };
      await bad({ sources: Array.from({ length: MAX_SOURCES + 1 }, () => one) }, /up to 12/i);
    });
    it("a file that is not a PDF, no pages chosen, or a page that does not exist", async () => {
      await bad({ sources: [{ title: "Broken", bytes: new TextEncoder().encode("not a pdf"), pages: [1] }] }, /"Broken" could not be read/i);
      await bad({ sources: [{ title: "Empty pick", bytes: await pdf([300]), pages: [] }] }, /choose at least one page from "Empty pick"/i);
      await bad({ sources: [{ title: "Short", bytes: await pdf([300, 301]), pages: [3] }] }, /has 2 pages, so page 3 does not exist/i);
    });
  });
});
