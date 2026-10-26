import "server-only";
import { PDFDocument } from "pdf-lib";
import type { Direction } from "./bidi";
import { addFrontMatter, frontMatterPageCount, type FrontEntry } from "./frontmatter";

/** A refusal with a plain-language message that is safe to show the person as it is. */
export class BuilderError extends Error {}

export const MAX_SOURCES = 12;
export const MAX_TITLE_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 600;
const MIN_SIDE_PT = 200;
const MAX_SIDE_PT = 1700;
const LETTER = { width: 612, height: 792 };

export interface BuilderSource {
  title: string;
  bytes: Uint8Array;
  /** 1-based pages to take from this source, in the order they should appear. */
  pages: number[];
  /** "Mafteiach (mafteiach.app)": shown as "Courtesy of ..." on the contents page. */
  credit?: string;
}

export interface BuilderInput {
  title: string;
  description: string;
  direction: Direction;
  sources: BuilderSource[];
  cover: boolean;
  contents: boolean;
}

export interface BuilderResult {
  bytes: Uint8Array;
  pageCount: number;
  /** Where each source starts in the finished document (cover and contents pages count). */
  entries: FrontEntry[];
}

const clamp = (n: number) => Math.min(MAX_SIDE_PT, Math.max(MIN_SIDE_PT, n));

/**
 * Combines several PDFs into ONE document for the booklet pipeline: an optional cover (title and description), an optional
 * contents page (each source's title with the page it starts on, and "Courtesy of" credits), then the chosen pages of every
 * source in order. The result is then printed like any other upload (preview, blank pages, imposition, rules), so nothing
 * about printing is duplicated here. Pages are COPIED into a new document: nothing else from a source (scripts, attachments,
 * form data) comes along.
 */
export async function assembleBooklet(input: BuilderInput): Promise<BuilderResult> {
  const title = input.title.trim();
  if (!title) throw new BuilderError("Give the booklet a name.");
  if (title.length > MAX_TITLE_LENGTH) throw new BuilderError(`The name is too long (at most ${MAX_TITLE_LENGTH} characters).`);
  if (input.description.length > MAX_DESCRIPTION_LENGTH) throw new BuilderError(`The description is too long (at most ${MAX_DESCRIPTION_LENGTH} characters).`);
  if (input.sources.length === 0) throw new BuilderError("Add at least one file to the booklet.");
  if (input.sources.length > MAX_SOURCES) throw new BuilderError(`A booklet can combine up to ${MAX_SOURCES} files.`);

  const docs: PDFDocument[] = [];
  for (const [i, s] of input.sources.entries()) {
    const label = s.title.trim() || `File ${i + 1}`;
    let doc: PDFDocument;
    try {
      doc = await PDFDocument.load(s.bytes, { updateMetadata: false });
    } catch {
      throw new BuilderError(`"${label}" could not be read as a PDF.`);
    }
    if (s.pages.length === 0) throw new BuilderError(`Choose at least one page from "${label}".`);
    const total = doc.getPageCount();
    for (const p of s.pages) {
      if (!Number.isInteger(p) || p < 1 || p > total) throw new BuilderError(`"${label}" has ${total} ${total === 1 ? "page" : "pages"}, so page ${p} does not exist.`);
    }
    docs.push(doc);
  }

  // The cover and contents take the size of the first page that will be in the booklet.
  const first = docs[0]!.getPage(input.sources[0]!.pages[0]! - 1).getSize();
  const size = first.width > 0 && first.height > 0 ? { width: clamp(first.width), height: clamp(first.height) } : LETTER;

  const credits = [...new Set(input.sources.map((s) => (s.credit ?? "").trim()).filter(Boolean))];
  const titles = input.sources.map((s, i) => s.title.trim() || `File ${i + 1}`);
  const draft = titles.map((t) => ({ title: t, startPage: 0 }));
  const base = { title, description: input.description, direction: input.direction, credits, cover: input.cover, contents: input.contents, size };

  // Page numbers depend on how many front pages there are, which depends only on the titles.
  const frontPages = await frontMatterPageCount({ ...base, entries: draft });
  let next = frontPages + 1;
  const entries: FrontEntry[] = input.sources.map((s, i) => {
    const entry = { title: titles[i]!, startPage: next };
    next += s.pages.length;
    return entry;
  });

  const out = await PDFDocument.create();
  out.setTitle(title);
  out.setProducer("Printio");
  const added = await addFrontMatter(out, { ...base, entries });
  if (added !== frontPages) throw new BuilderError("The cover and contents could not be laid out. Try a shorter name or fewer files.");

  for (const [i, s] of input.sources.entries()) {
    const copied = await out.copyPages(docs[i]!, s.pages.map((p) => p - 1));
    for (const page of copied) out.addPage(page);
  }
  return { bytes: await out.save(), pageCount: out.getPageCount(), entries };
}
