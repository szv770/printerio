import { parse, type HTMLElement } from "node-html-parser";

/**
 * Reads the pages of mafteiach.app (a library of sichos and maamarim) into plain data. Pure: it takes the page's HTML and
 * returns what is on it, so it is tested against saved copies of the real pages. It never follows or fetches anything, and
 * it keeps ONLY links to Google Drive or Docs files (the files themselves are fetched later through the same safe link
 * import as any pasted link). Markup it does not recognise gives an empty result, never an error: if the site changes,
 * the screen says the library looks different today rather than breaking.
 */

export interface LibraryLink {
  label: string;
  url: string;
}

/** One sicha in a Likkutei Sichos volume. */
export interface LikkutEntry {
  id: string;
  /** "ח"א ע' 1 (בראשית)" */
  label: string;
  summary: string;
  links: LibraryLink[];
}

export interface LikkutParsha {
  name: string;
  entries: LikkutEntry[];
}

export interface LikkutPage {
  volumes: { n: number; label: string }[];
  current: number | null;
  parshiyos: LikkutParsha[];
}

export interface ListEntry {
  kind: "maamor" | "farbrengen";
  /** The maamar's number, or the farbrengen's date ("5711-01-01"). */
  id: string;
  /** Path of the entry's own page on the site: /maamorim/1 or /all/5711-01-01. */
  path: string;
  /** The date or occasion shown above a maamar ("יו"ד שבט"); empty for a farbrengen. */
  heading: string;
  title: string;
  /** "[המשך: א]" */
  note: string;
  /** "קונטרס: מאמר יו"ד שבט ה'תשי"א" */
  series: string;
}

export interface ListPage {
  years: { year: string; label: string; current: boolean }[];
  entries: ListEntry[];
}

/** One edition group inside a section ("מוגה", "בלתי מוגה - מהדורה ישנה"); label is "" when the section has no groups. */
export interface EntryGroup {
  label: string;
  links: LibraryLink[];
}

export interface EntrySection {
  title: string;
  groups: EntryGroup[];
}

const clean = (s: string) => s.replace(/[ ‎‏]/g, " ").replace(/\s+/g, " ").trim();
const textOf = (el: HTMLElement | null | undefined) => (el ? clean(el.text) : "");

/** A Google Drive or Docs file address over https, or null. Everything else on the page is ignored. */
function googleFileUrl(href: string | undefined): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return url.hostname === "drive.google.com" || url.hostname === "docs.google.com" ? url.toString() : null;
}

function googleLinks(root: HTMLElement): LibraryLink[] {
  const links: LibraryLink[] = [];
  for (const a of root.querySelectorAll("a[href]")) {
    const url = googleFileUrl(a.getAttribute("href"));
    if (url) links.push({ label: textOf(a), url });
  }
  return links;
}

export function parseLikkutSichos(html: string): LikkutPage {
  const root = parse(html);
  const volumes: LikkutPage["volumes"] = [];
  let current: number | null = null;
  for (const b of root.querySelectorAll("button.volume")) {
    const n = Number(/^volume_(\d+)$/.exec(b.id)?.[1]);
    if (!Number.isInteger(n)) continue;
    volumes.push({ n, label: textOf(b) });
    if (b.classList.contains("active")) current = n;
  }

  const parshiyos: LikkutParsha[] = [];
  for (const p of root.querySelectorAll(".parsha")) {
    const head = p.querySelector("button.parsha-button");
    if (!head) continue;
    const thin = textOf(head.querySelector(".thin-font"));
    const name = clean(textOf(head).replace(thin, ""));
    const entries: LikkutEntry[] = [];
    for (const b of p.querySelectorAll("button.likkut-sicha-button")) {
      const content = p.querySelector(`#${b.id.replace(/__button$/, "__content")}`);
      if (!content) continue;
      entries.push({
        id: b.id.replace(/^likkut_sicha_/, "").replace(/__button$/, ""),
        label: textOf(b),
        summary: textOf(content.querySelector(".trix-content")),
        links: googleLinks(content),
      });
    }
    if (name) parshiyos.push({ name, entries });
  }
  return { volumes, current, parshiyos };
}

function listEntry(el: HTMLElement): ListEntry | null {
  const button = el.querySelector("button.farbrengen-button");
  const onclick = button?.getAttribute("onclick") ?? "";
  const maamor = /loadMaamorFragment\(\s*event\s*,\s*(\d+)/.exec(onclick);
  if (maamor) {
    const id = maamor[1]!;
    const stack = button!.querySelector(".tw-flex-col");
    const rows = stack ? stack.childNodes.filter((n): n is HTMLElement => "tagName" in n && !!n.tagName) : [];
    const titleRow = rows[1];
    return {
      kind: "maamor",
      id,
      path: `/maamorim/${id}`,
      heading: textOf(rows[0]),
      title: textOf(titleRow?.querySelector(".thick-font")),
      note: textOf(titleRow?.querySelectorAll("span").find((s) => !s.classList.contains("thick-font"))),
      series: textOf(rows[2]),
    };
  }
  const farb = /loadFarbrengenFragment\(\s*event\s*,\s*\d+\s*,\s*\w+\s*,\s*'([0-9A-Za-z-]+)'/.exec(onclick);
  if (farb) {
    const id = farb[1]!;
    const label = button!.querySelector("div");
    return { kind: "farbrengen", id, path: `/all/${id}`, heading: "", title: clean(textOf(label).replace("expand_more", "")), note: "", series: "" };
  }
  return null;
}

/** A year's list of maamarim, or of sichos and farbrengens: the year tabs and the entries (not their files; those are on each entry's own page). */
export function parseListPage(html: string): ListPage {
  const root = parse(html);
  const years: ListPage["years"] = [];
  for (const a of root.querySelectorAll("a.year")) {
    const href = a.getAttribute("href") ?? "";
    const year = /[?&]year=([\d_]+)/.exec(href)?.[1] ?? /\/by_year\/([\d_]+)/.exec(href)?.[1];
    if (year) years.push({ year, label: textOf(a), current: a.classList.contains("active") });
  }
  const entries: ListEntry[] = [];
  for (const el of root.querySelectorAll("div.farbrengen")) {
    const entry = listEntry(el);
    if (entry) entries.push(entry);
  }
  return { years, entries };
}

/** What one entry's own page offers: its sections (editions, notes, translations) with the files in each. Sections with no files are left out. */
export function parseEntryPage(html: string): EntrySection[] {
  const root = parse(html);
  const sections: EntrySection[] = [];
  for (const block of root.querySelectorAll(".farbrengen-detail-content")) {
    const groups: EntryGroup[] = [{ label: "", links: [] }];
    for (const el of block.querySelectorAll("h5, a[href]")) {
      if (el.tagName === "H5") {
        groups.push({ label: textOf(el), links: [] });
        continue;
      }
      const url = googleFileUrl(el.getAttribute("href"));
      if (url) groups[groups.length - 1]!.links.push({ label: textOf(el), url });
    }
    const withFiles = groups.filter((g) => g.links.length > 0);
    if (withFiles.length > 0) sections.push({ title: textOf(block.querySelector("h4")), groups: withFiles });
  }
  return sections;
}
