/**
 * Detects the PDF constructs that can carry *active* content - the realistic
 * residual risk in an upload-and-print pipeline once the file has already been
 * proven to be a structurally valid PDF (lib/pdf/preflight.ts).
 *
 * Why this is the right-sized control here (docs/architecture.md sec 5.1):
 * Printio never renders an uploaded PDF in a viewer on the server, and the
 * Agent hands the file to SumatraPDF/the Windows print pipeline, which draws
 * page content - it does not run document scripts or open attachments. So the
 * dangerous part of a PDF is not its page content at all; it is the small set
 * of constructs a *reader* application might act on if a human later opened
 * the same file: an embedded JavaScript action, a /Launch action (an
 * instruction to run a program or open another document), or an embedded file
 * attachment (the classic way a PDF is used as a container to smuggle
 * something else). None of the three has any legitimate role in a document
 * somebody wants printed on paper, so a job declaring any of them is rejected
 * outright with a plain-English explanation rather than accepted, stored, and
 * handed onward.
 *
 * This is NOT antivirus and is not presented as such - see
 * docs/architecture.md sec 5.1 and docs/known-limitations.md.
 *
 * Implementation note: the scan walks pdf-lib's *parsed* object graph
 * (every indirect object, recursing through directly-nested dictionaries and
 * arrays), not the raw bytes. That matters: modern PDFs pack most of their
 * objects into compressed object streams, so a naive byte search for "/JS"
 * would both miss the real thing and fire on unrelated bytes inside a content
 * or image stream. Refs are never followed - every indirect object is visited
 * exactly once by the top-level enumeration anyway.
 */

import { PDFArray, PDFDict, PDFName, PDFStream, type PDFDocument, type PDFObject } from "pdf-lib";

export type ActiveContentKind = "javascript" | "launch_action" | "embedded_file";

/** Defensive cap on how deep a single directly-nested structure is followed.
 *  Nothing legitimate nests remotely this deep; it exists so a hostile file
 *  cannot turn preflight into unbounded recursion. */
const MAX_DEPTH = 48;

const KIND_DESCRIPTIONS: Record<ActiveContentKind, string> = {
  javascript: "embedded JavaScript",
  launch_action: "a launch action (an instruction to run a program or open another file)",
  embedded_file: "an embedded file attachment",
};

/**
 * Returns every kind of active content this document declares, deduplicated
 * and in a stable order. An empty array means the document is page content
 * only - the normal case for anything produced by "Save as PDF"/"Print to
 * PDF" from Word, Google Docs, a scanner, or a browser.
 */
export function findActiveContent(doc: PDFDocument): ActiveContentKind[] {
  const found = new Set<ActiveContentKind>();
  const seen = new Set<PDFObject>();

  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    inspect(object, found, seen, 0);
  }
  // The catalog is normally an indirect object (so already covered above), but
  // it is cheap insurance to scan it explicitly - /OpenAction and the
  // /Names -> /JavaScript name tree both hang off it, and both may be written
  // as direct (inline) dictionaries.
  inspect(doc.catalog, found, seen, 0);

  return (["javascript", "launch_action", "embedded_file"] as const).filter((kind) => found.has(kind));
}

function inspect(object: PDFObject, found: Set<ActiveContentKind>, seen: Set<PDFObject>, depth: number): void {
  if (depth > MAX_DEPTH || seen.has(object)) return;
  seen.add(object);

  if (object instanceof PDFStream) {
    inspect(object.dict, found, seen, depth + 1);
    return;
  }

  if (object instanceof PDFArray) {
    for (let i = 0; i < object.size(); i += 1) {
      const item = object.get(i);
      if (item) inspect(item, found, seen, depth + 1);
    }
    return;
  }

  if (!(object instanceof PDFDict)) return;

  for (const [key, value] of object.entries()) {
    classify(key, value, found);
    inspect(value, found, seen, depth + 1);
  }
}

function classify(key: PDFName, value: PDFObject, found: Set<ActiveContentKind>): void {
  // asString() includes the leading slash, e.g. "/JS".
  switch (key.asString()) {
    case "/JS":
      // The script payload of a JavaScript action.
      found.add("javascript");
      return;
    case "/JavaScript":
      // The document-level JavaScript name tree (catalog /Names /JavaScript).
      found.add("javascript");
      return;
    case "/EF":
      // A file specification's actual embedded file streams.
      found.add("embedded_file");
      return;
    case "/EmbeddedFiles":
      // The document-level attachment name tree.
      found.add("embedded_file");
      return;
    case "/S":
      // An action dictionary's subtype - /JavaScript and /Launch are the two
      // that make an action do something other than move around the document.
      if (value instanceof PDFName) {
        if (value.asString() === "/JavaScript") found.add("javascript");
        else if (value.asString() === "/Launch") found.add("launch_action");
      }
      return;
    case "/Subtype":
      if (value instanceof PDFName && value.asString() === "/EmbeddedFile") found.add("embedded_file");
      return;
    default:
      return;
  }
}

/**
 * The message a submitter actually sees. Names what was found and what to do
 * about it - re-exporting/printing to PDF drops all three constructs, which
 * is a step a student or teacher can genuinely carry out unaided.
 */
export function activeContentRejectionMessage(kinds: ActiveContentKind[]): string {
  const list = kinds.map((k) => KIND_DESCRIPTIONS[k]);
  const described =
    list.length === 1
      ? list[0]
      : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  return (
    `This PDF contains ${described}, which Printio does not accept for printing. ` +
    "Open it in your PDF reader and use Print → Save as PDF to produce a plain, " +
    "print-only copy, then upload that instead."
  );
}
