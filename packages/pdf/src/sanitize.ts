/**
 * Removes the parts of a PDF that can carry active or hidden content - embedded file attachments, JavaScript and
 * launch actions - while leaving every page's visible content exactly as it was.
 *
 * Why sanitize instead of reject: a teacher printing from Android (or any print dialog) cannot fix an attachment
 * the phone put into the file, so refusing the print only strands them. None of these constructs paints anything
 * on paper, so dropping them changes nothing that prints. Page content streams, fonts, images, page boxes and
 * ordinary links/annotations are never touched.
 *
 * What is removed (see active-content.ts for how each is detected):
 *  - embedded files: the catalog /Names /EmbeddedFiles tree, /AF (associated files) on any object, /EF file
 *    streams, FileAttachment annotations (and the filespec they point at), and every /EmbeddedFile stream;
 *  - JavaScript: the catalog /Names /JavaScript tree and every /JavaScript action;
 *  - /Launch actions;
 *  - /AA (additional-action triggers) everywhere - they only exist to fire the actions above and have no effect
 *    on print.
 * Anything else the document does (links, bookmarks, form fields' appearance) is left alone.
 *
 * Safety net: the result is re-parsed and re-scanned; if anything active is still found, or pdf-lib cannot write
 * the file, the caller gets { ok: false } and falls back to rejecting the upload. A file with nothing to remove
 * is returned byte-for-byte (the very same array).
 */

import { EncryptedPDFError, PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream, type PDFContext, type PDFObject } from "pdf-lib";
import { findActiveContent, type ActiveContentKind } from "./active-content";

export type SanitizeResult =
  | { ok: true; bytes: Uint8Array; removed: ActiveContentKind[] }
  | { ok: false; reason: "encrypted" | "unreadable" };

const MAX_DEPTH = 48;
/** Keys dropped wherever they appear. */
const DROP_KEYS = new Set(["/AF", "/EF", "/AA", "/EmbeddedFiles", "/JavaScript"]);

const NAME_S = PDFName.of("S");
const NAME_TYPE = PDFName.of("Type");
const NAME_SUBTYPE = PDFName.of("Subtype");

function isBadAction(value: PDFObject | undefined): boolean {
  if (!(value instanceof PDFDict)) return false;
  const s = value.get(NAME_S);
  return s instanceof PDFName && (s.asString() === "/JavaScript" || s.asString() === "/Launch");
}

function subtypeOf(dict: PDFDict): string | undefined {
  const s = dict.get(NAME_SUBTYPE);
  return s instanceof PDFName ? s.asString() : undefined;
}

/** pdf-lib's EncryptedPDFError does not always survive `instanceof` (compiled class), so also check the message. */
export function isEncryptedError(err: unknown): boolean {
  return err instanceof EncryptedPDFError || (err instanceof Error && /encrypted/i.test(err.message));
}

export async function sanitizePdf(bytes: Uint8Array): Promise<SanitizeResult> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
    doc.getPageCount(); // a file whose page tree is broken only fails here
  } catch (err) {
    return { ok: false, reason: isEncryptedError(err) ? "encrypted" : "unreadable" };
  }

  const removed = findActiveContent(doc);
  if (removed.length === 0) return { ok: true, bytes, removed: [] };

  try {
    const ctx = doc.context;
    const doomed = new Set<PDFRef>();
    const seen = new Set<PDFObject>();

    const queue = (ref: PDFRef | undefined) => {
      if (ref) doomed.add(ref);
    };

    /** Resolves one level of indirection. */
    const resolve = (v: PDFObject | undefined): PDFObject | undefined => (v instanceof PDFRef ? ctx.lookup(v) : v);

    /** True for an annotation dictionary that attaches a file. */
    const isFileAttachment = (v: PDFObject | undefined): boolean => {
      const d = resolve(v);
      return d instanceof PDFDict && subtypeOf(d) === "/FileAttachment";
    };

    function scrub(obj: PDFObject | undefined, depth: number): void {
      if (!obj || depth > MAX_DEPTH || seen.has(obj)) return;
      seen.add(obj);
      if (obj instanceof PDFStream) {
        scrub(obj.dict, depth + 1);
        return;
      }
      if (obj instanceof PDFArray) {
        for (let i = obj.size() - 1; i >= 0; i -= 1) {
          const item = obj.get(i);
          if (isBadAction(resolve(item)) || isFileAttachment(item)) {
            if (item instanceof PDFRef) {
              queue(item);
              const target = resolve(item);
              if (target instanceof PDFDict) queueFileSpecAndScript(target);
            }
            obj.remove(i);
          } else if (!(item instanceof PDFRef)) {
            scrub(item, depth + 1);
          }
        }
        return;
      }
      if (!(obj instanceof PDFDict)) return;

      // Collect first: deleting while iterating entries() is not safe.
      for (const [key, value] of [...obj.entries()]) {
        const name = key.asString();
        if (DROP_KEYS.has(name) || isBadAction(resolve(value))) {
          if (value instanceof PDFRef) {
            queue(value);
            const target = resolve(value);
            if (target instanceof PDFDict) queueFileSpecAndScript(target);
          }
          obj.delete(key);
        } else if (!(value instanceof PDFRef)) {
          scrub(value, depth + 1);
        }
      }
    }

    /** An annotation's /FS filespec and an action's /JS stream die with the thing that referenced them. */
    function queueFileSpecAndScript(d: PDFDict): void {
      for (const k of ["FS", "JS"]) {
        const v = d.get(PDFName.of(k));
        if (v instanceof PDFRef) queue(v);
      }
    }

    for (const [ref, object] of ctx.enumerateIndirectObjects()) {
      const dict = object instanceof PDFStream ? object.dict : object instanceof PDFDict ? object : null;
      if (dict) {
        const type = dict.get(NAME_TYPE);
        const isEmbeddedFileStream = object instanceof PDFStream && subtypeOf(dict) === "/EmbeddedFile";
        const isFilespecWithFile = dict.has(PDFName.of("EF")) || (type instanceof PDFName && type.asString() === "/EmbeddedFile");
        // Whole indirect objects that exist only to hold the unwanted thing.
        if (isEmbeddedFileStream || isFilespecWithFile || isBadAction(dict) || subtypeOf(dict) === "/FileAttachment") {
          queue(ref);
          queueFileSpecAndScript(dict);
        }
      }
      scrub(object, 0);
    }
    scrub(doc.catalog, 0);

    // An emptied /Names dictionary is just noise.
    const names = doc.catalog.lookup(PDFName.of("Names"));
    if (names instanceof PDFDict && names.keys().length === 0) doc.catalog.delete(PDFName.of("Names"));

    for (const ref of doomed) ctx.delete(ref);
    removeDanglingRefs(ctx, doomed);

    const out = await doc.save({ updateFieldAppearances: false });

    // Verify with a fresh parse of exactly what we are about to hand on.
    const check = await PDFDocument.load(out, { updateMetadata: false });
    if (findActiveContent(check).length > 0) return { ok: false, reason: "unreadable" };
    if (check.getPageCount() !== doc.getPageCount()) return { ok: false, reason: "unreadable" };
    return { ok: true, bytes: out, removed };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/**
 * References to deleted objects resolve to null in a PDF, which is legal, but an array full of nulls (a name tree
 * whose entries were removed) is untidy; drop them from arrays that hold nothing else of interest.
 */
function removeDanglingRefs(ctx: PDFContext, doomed: Set<PDFRef>): void {
  for (const [, object] of ctx.enumerateIndirectObjects()) {
    const dict = object instanceof PDFStream ? object.dict : object instanceof PDFDict ? object : null;
    if (!dict) continue;
    for (const [, value] of dict.entries()) {
      if (value instanceof PDFArray) {
        for (let i = value.size() - 1; i >= 0; i -= 1) {
          const item = value.get(i);
          if (item instanceof PDFRef && doomed.has(item)) value.remove(i);
        }
      }
    }
  }
}
