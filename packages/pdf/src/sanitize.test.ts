import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, PDFHexString } from "pdf-lib";
import { findActiveContent } from "./active-content";
import { sanitizePdf } from "./sanitize";

async function pdfWithText(pages = 2): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612 + i * 10, 792]);
    p.drawText(`page ${i + 1}`, { x: 50, y: 700 });
  }
  return doc;
}

function pageContent(doc: PDFDocument, i: number): string {
  const contents = doc.getPage(i).node.Contents();
  // A single stream for pages made by pdf-lib's drawText path.
  const arr = contents instanceof PDFArray ? contents : null;
  const stream = (arr ? doc.context.lookup(arr.get(0)) : contents) as { getContents(): Uint8Array } | undefined;
  return Buffer.from(stream!.getContents()).toString("latin1");
}

async function withNameTreeAttachment(): Promise<Uint8Array> {
  const doc = await pdfWithText();
  await doc.attach(new Uint8Array([1, 2, 3, 4]), "payload.bin", { mimeType: "application/octet-stream" });
  return doc.save();
}

async function withFileAttachmentAnnotation(): Promise<Uint8Array> {
  const doc = await pdfWithText();
  const ef = doc.context.stream(new Uint8Array([9, 9, 9]), { Type: "EmbeddedFile" });
  const efRef = doc.context.register(ef);
  const fs = doc.context.obj({ Type: "Filespec", F: PDFString.of("a.bin"), EF: { F: efRef } });
  const fsRef = doc.context.register(fs);
  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "FileAttachment",
    Rect: [10, 10, 30, 30],
    FS: fsRef,
    Name: "PushPin",
  });
  const annotRef = doc.context.register(annot);
  doc.getPage(0).node.set(PDFName.of("Annots"), doc.context.obj([annotRef]));
  // /AF on the catalog, too.
  doc.catalog.set(PDFName.of("AF"), doc.context.obj([fsRef]));
  return doc.save();
}

describe("sanitizePdf", () => {
  it("removes a catalog /EmbeddedFiles attachment and keeps the pages exactly as they were", async () => {
    const input = await withNameTreeAttachment();
    const before = await PDFDocument.load(input);
    expect(findActiveContent(before)).toContain("embedded_file");

    const out = await sanitizePdf(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.removed).toContain("embedded_file");

    const after = await PDFDocument.load(out.bytes);
    expect(findActiveContent(after)).toEqual([]);
    expect(after.getPageCount()).toBe(2);
    for (let i = 0; i < 2; i++) {
      expect(after.getPage(i).getSize()).toEqual(before.getPage(i).getSize());
      expect(pageContent(after, i)).toBe(pageContent(before, i));
    }
    // The attachment bytes are really gone, not merely unreferenced.
    expect(out.bytes.byteLength).toBeLessThan(input.byteLength);
    expect(after.catalog.lookup(PDFName.of("Names"))).toBeUndefined();
    expect(after.catalog.get(PDFName.of("AF"))).toBeUndefined();
  });

  it("removes a FileAttachment annotation, its /FS filespec, its embedded stream and catalog /AF", async () => {
    const input = await withFileAttachmentAnnotation();
    const out = await sanitizePdf(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const after = await PDFDocument.load(out.bytes);
    expect(findActiveContent(after)).toEqual([]);
    expect(after.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
    expect(after.catalog.get(PDFName.of("AF"))).toBeUndefined();
    for (const [, obj] of after.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict) {
        expect(obj.get(PDFName.of("Subtype"))?.toString()).not.toBe("/FileAttachment");
        expect(obj.get(PDFName.of("Type"))?.toString()).not.toBe("/Filespec");
      }
    }
    expect(Buffer.from(out.bytes).includes(Buffer.from([9, 9, 9]))).toBe(false);
    expect(pageContent(after, 0)).toBe(pageContent(await PDFDocument.load(input), 0));
  });

  it("keeps other annotations (links) on the page", async () => {
    const doc = await pdfWithText(1);
    const link = doc.context.register(
      doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 5, 5], A: { S: "URI", URI: PDFString.of("https://example.org") } }),
    );
    const att = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "FileAttachment", Rect: [0, 0, 5, 5] }));
    doc.getPage(0).node.set(PDFName.of("Annots"), doc.context.obj([link, att]));
    const out = await sanitizePdf(await doc.save());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const after = await PDFDocument.load(out.bytes);
    expect(after.getPage(0).node.Annots()?.size()).toBe(1);
  });

  it("removes JavaScript and launch actions (document, annotation and form-field level)", async () => {
    const doc = await pdfWithText(1);
    doc.catalog.set(PDFName.of("OpenAction"), doc.context.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of("app.alert(1)") }));
    const js = doc.context.register(doc.context.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of("app.alert(2)") }));
    doc.catalog.set(PDFName.of("Names"), doc.context.obj({ JavaScript: { Names: [PDFHexString.fromText("x"), js] } }));
    const link = doc.context.register(
      doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 5, 5], A: { S: "Launch", F: PDFString.of("calc.exe") } }),
    );
    doc.getPage(0).node.set(PDFName.of("Annots"), doc.context.obj([link]));
    const input = await doc.save();
    expect(findActiveContent(await PDFDocument.load(input))).toEqual(expect.arrayContaining(["javascript", "launch_action"]));

    const out = await sanitizePdf(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.removed).toEqual(expect.arrayContaining(["javascript", "launch_action"]));
    expect(findActiveContent(await PDFDocument.load(out.bytes))).toEqual([]);
  });

  it("leaves a clean PDF untouched (same bytes, nothing removed)", async () => {
    const bytes = await (await pdfWithText()).save();
    const out = await sanitizePdf(bytes);
    expect(out).toEqual({ ok: true, bytes, removed: [] });
  });

  it("reports an encrypted or corrupt file as not ok", async () => {
    const bad = await sanitizePdf(new TextEncoder().encode("%PDF-1.4\n%garbage garbage garbage, not a real xref table"));
    expect(bad).toEqual({ ok: false, reason: "unreadable" });
  });
});
