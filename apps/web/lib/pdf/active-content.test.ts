import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { activeContentRejectionMessage, findActiveContent } from "./active-content";

/** Builds a real PDF, saves it, and re-loads it - so every assertion below is
 *  made against a parsed document exactly as preflight sees it, not against
 *  the in-memory object graph the test just built by hand. */
async function roundTrip(build: (doc: PDFDocument) => void | Promise<void>): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  await build(doc);
  const bytes = await doc.save();
  return PDFDocument.load(bytes, { updateMetadata: false });
}

describe("findActiveContent", () => {
  it("finds nothing in an ordinary, page-content-only PDF", async () => {
    const doc = await roundTrip(() => {});
    expect(findActiveContent(doc)).toEqual([]);
  });

  it("finds document-level JavaScript reached through the catalog's OpenAction", async () => {
    const doc = await roundTrip((d) => {
      d.catalog.set(
        PDFName.of("OpenAction"),
        d.context.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of("app.alert('hello')") }),
      );
    });
    expect(findActiveContent(doc)).toEqual(["javascript"]);
  });

  it("finds a JavaScript action nested inside a page annotation", async () => {
    const doc = await roundTrip((d) => {
      const page = d.getPage(0);
      page.node.set(
        PDFName.of("Annots"),
        d.context.obj([
          {
            Type: "Annot",
            Subtype: "Widget",
            Rect: [0, 0, 10, 10],
            A: { S: "JavaScript", JS: PDFString.of("this.print()") },
          },
        ]),
      );
    });
    expect(findActiveContent(doc)).toEqual(["javascript"]);
  });

  it("finds a /Launch action", async () => {
    const doc = await roundTrip((d) => {
      d.catalog.set(PDFName.of("OpenAction"), d.context.obj({ Type: "Action", S: "Launch", F: PDFString.of("cmd.exe") }));
    });
    expect(findActiveContent(doc)).toEqual(["launch_action"]);
  });

  it("finds an embedded file attachment", async () => {
    const doc = await roundTrip(async (d) => {
      await d.attach(new Uint8Array([1, 2, 3, 4]), "payload.bin", { mimeType: "application/octet-stream" });
    });
    expect(findActiveContent(doc)).toContain("embedded_file");
  });

  it("reports every distinct kind present, deduplicated and in a stable order", async () => {
    const doc = await roundTrip(async (d) => {
      d.catalog.set(PDFName.of("OpenAction"), d.context.obj({ S: "JavaScript", JS: PDFString.of("a()") }));
      d.catalog.set(PDFName.of("AA"), d.context.obj({ WC: { S: "JavaScript", JS: PDFString.of("b()") } }));
      await d.attach(new Uint8Array([9]), "note.txt", { mimeType: "text/plain" });
    });
    expect(findActiveContent(doc)).toEqual(["javascript", "embedded_file"]);
  });

  it("does not flag an ordinary external-link (URI) annotation - a link is inert on paper", async () => {
    const doc = await roundTrip((d) => {
      const page = d.getPage(0);
      page.node.set(
        PDFName.of("Annots"),
        d.context.obj([
          {
            Type: "Annot",
            Subtype: "Link",
            Rect: [0, 0, 10, 10],
            A: { S: "URI", URI: PDFString.of("https://example.org") },
          },
        ]),
      );
    });
    expect(findActiveContent(doc)).toEqual([]);
  });

  it("does not flag a document that merely contains the text '/JS' inside page content", async () => {
    const doc = await roundTrip((d) => {
      const page = d.getPage(0);
      page.drawText("/JS /JavaScript /Launch /EmbeddedFile", { size: 10 });
    });
    expect(findActiveContent(doc)).toEqual([]);
  });
});

describe("activeContentRejectionMessage", () => {
  it("names the single thing it found and what to do about it", () => {
    const message = activeContentRejectionMessage(["javascript"]);
    expect(message).toMatch(/embedded JavaScript/);
    expect(message).toMatch(/Save as PDF/i);
  });

  it("reads as a list when several kinds were found", () => {
    const message = activeContentRejectionMessage(["javascript", "launch_action", "embedded_file"]);
    expect(message).toMatch(/embedded JavaScript, a launch action.* and an embedded file attachment/);
  });
});
