"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowDown, ArrowUp, BookOpen, FileText, Link2, Plus, Trash2 } from "lucide-react";
import { Button, Checkbox, Field, FormError, Input, Segmented, Textarea } from "@/components/ui";
import { PagePicker } from "@/components/print/PagePicker";
import { precheckSelectedFile } from "@/lib/pdf/client-precheck";
import { putBuiltBooklet } from "@/lib/booklet/handoff";
import { builderPrintUrl, type SheetChoice } from "@/lib/booklet/builder-params";
import { clearDraft, readDraft, saveDraft, type DraftSource } from "@/lib/booklet/draft";
import { clearCart, readCart, type CartItem } from "@/lib/library/cart";
import { importLinkAction } from "@/app/(dashboard)/print/import-link-action";
import { buildBookletAction } from "@/app/(dashboard)/print/booklet/actions";

const MAX_SOURCES = 12;

type Source = DraftSource;

const nameFromFile = (n: string) => n.replace(/\.pdf$/i, "").replace(/_+/g, " ").trim();

/** Builds one PDF from several (cover, contents, the chosen pages of each), then opens the normal Print page with it. */
export function BookletBuilder({ maxUploadBytes }: { maxUploadBytes: number }) {
  const router = useRouter();
  const nextId = useRef(Math.max(0, ...(readDraft()?.sources.map((s) => s.id) ?? [])) + 1);
  const fileInput = useRef<HTMLInputElement>(null);
  // Kept while you visit the library to pick more and come back (lib/booklet/draft.ts).
  const [sources, setSources] = useState<Source[]>(() => readDraft()?.sources ?? []);
  const [title, setTitle] = useState(() => readDraft()?.title ?? "");
  const [description, setDescription] = useState(() => readDraft()?.description ?? "");
  const [direction, setDirection] = useState<"ltr" | "rtl">(() => readDraft()?.direction ?? "ltr");
  const [cover, setCover] = useState(() => readDraft()?.cover ?? true);
  const [contents, setContents] = useState(() => readDraft()?.contents ?? true);
  const [sheet, setSheet] = useState<SheetChoice>(() => readDraft()?.sheet ?? "letter");
  const [link, setLink] = useState("");
  const [addError, setAddError] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [adding, startAdd] = useTransition();
  const [building, startBuild] = useTransition();
  const [picking, setPicking] = useState<number | null>(null);
  const [libraryProgress, setLibraryProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    saveDraft({ sources, title, description, direction, cover, contents, sheet });
  }, [sources, title, description, direction, cover, contents, sheet]);

  async function addFile(file: File, credit = "", title?: string, pages = "") {
    const verdict = precheckSelectedFile(file, maxUploadBytes);
    if (!verdict.ok) throw new Error(verdict.reason);
    const bytes = await file.arrayBuffer();
    const { PDFDocument } = await import("pdf-lib");
    let totalPages: number;
    try {
      totalPages = (await PDFDocument.load(bytes.slice(0), { updateMetadata: false })).getPageCount();
    } catch {
      throw new Error(`"${file.name}" could not be read as a PDF.`);
    }
    setSources((cur) => [...cur, { id: nextId.current++, title: title || nameFromFile(file.name), file, bytes, totalPages, pages, credit }]);
  }

  /** Files picked in the library: fetched one after another through the same safe link import as a pasted link. */
  async function importFromLibrary(items: CartItem[]) {
    const failed: string[] = [];
    for (const [i, item] of items.entries()) {
      setLibraryProgress({ done: i, total: items.length });
      try {
        const data = new FormData();
        data.set("link", item.url);
        const result = await importLinkAction(data);
        if (result.error || !result.imported) throw new Error(result.error ?? "import");
        const res = await fetch(result.imported.signedUrl, { cache: "no-store" });
        if (!res.ok) throw new Error("download");
        await addFile(new File([await res.blob()], result.imported.fileName, { type: "application/pdf", lastModified: Date.now() }), item.credit, item.title, item.pages);
      } catch {
        failed.push(item.title);
      }
    }
    setLibraryProgress(null);
    if (failed.length > 0) setAddError(`Printio could not get ${failed.length === 1 ? "this file" : "these files"} from the library: ${failed.join("; ")}. Go back to the library and try again.`);
  }

  // Coming from the library: add what was picked there, once.
  useEffect(() => {
    const t = setTimeout(() => {
      const items = readCart();
      if (items.length === 0) return;
      clearCart();
      void importFromLibrary(items);
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    setAddError(undefined);
    let count = sources.length;
    for (const f of files) {
      if (count >= MAX_SOURCES) {
        setAddError(`A booklet can combine up to ${MAX_SOURCES} files.`);
        return;
      }
      try {
        await addFile(f);
        count++;
      } catch (err) {
        setAddError(err instanceof Error ? err.message : "Could not add that file.");
      }
    }
  }

  function addLink() {
    setAddError(undefined);
    if (!link.trim()) return setAddError("Paste a link to a PDF.");
    if (sources.length >= MAX_SOURCES) return setAddError(`A booklet can combine up to ${MAX_SOURCES} files.`);
    startAdd(async () => {
      try {
        const data = new FormData();
        data.set("link", link);
        const result = await importLinkAction(data);
        if (result.error || !result.imported) return setAddError(result.error ?? "Something went wrong. Try again.");
        const res = await fetch(result.imported.signedUrl, { cache: "no-store" });
        if (!res.ok) throw new Error("download");
        const file = new File([await res.blob()], result.imported.fileName, { type: "application/pdf", lastModified: Date.now() });
        await addFile(file);
        setLink("");
      } catch (err) {
        setAddError(err instanceof Error && err.message !== "download" ? err.message : "Printio could not get that file. Try again.");
      }
    });
  }

  const update = (id: number, patch: Partial<Source>) => setSources((cur) => cur.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const move = (i: number, by: -1 | 1) =>
    setSources((cur) => {
      const j = i + by;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  function build(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (!title.trim()) return setError("Give the booklet a name.");
    if (sources.length === 0) return setError("Add at least one file.");
    startBuild(async () => {
      const data = new FormData();
      data.set("title", title);
      data.set("description", description);
      data.set("direction", direction);
      if (cover) data.set("cover", "on");
      if (contents) data.set("contents", "on");
      data.set("count", String(sources.length));
      sources.forEach((s, i) => {
        data.set(`file-${i}`, s.file);
        data.set(`title-${i}`, s.title);
        data.set(`pages-${i}`, s.pages);
        data.set(`credit-${i}`, s.credit);
      });
      try {
        const result = await buildBookletAction(data);
        if (result.error || !result.built) return setError(result.error ?? "Something went wrong. Try again.");
        const res = await fetch(result.built.signedUrl, { cache: "no-store" });
        if (!res.ok) throw new Error("download");
        putBuiltBooklet(new File([await res.blob()], result.built.fileName, { type: "application/pdf", lastModified: Date.now() }));
        clearDraft();
        router.push(builderPrintUrl(direction, sheet));
      } catch {
        setError("Printio built the booklet but your browser could not get it. Try again.");
      }
    });
  }

  const busy = adding || building;
  return (
    <form onSubmit={build} className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-base font-semibold">1. Add the files</h2>
        {libraryProgress && (
          <p role="status" className="text-sm text-[var(--color-muted)]">
            Getting your files from the library: {libraryProgress.done + 1} of {libraryProgress.total}...
          </p>
        )}
        {sources.length === 0 && !libraryProgress && (
          <p className="text-sm text-[var(--color-muted)]">PDFs from this device, or a link (a Google Drive file shared with &quot;Anyone with the link&quot; works).</p>
        )}
        <ul className="space-y-3">
          {sources.map((s, i) => (
            <li key={s.id} className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5">
              <div className="flex items-start gap-2">
                <FileText className="mt-3 h-4 w-4 shrink-0 text-[var(--color-muted)]" aria-hidden="true" />
                <Input aria-label={`Name of file ${i + 1}`} value={s.title} onChange={(e) => update(s.id, { title: e.target.value })} maxLength={120} disabled={busy} className="flex-1" />
                <div className="flex shrink-0">
                  <button type="button" aria-label="Move up" disabled={i === 0 || busy} onClick={() => move(i, -1)} className="flex h-11 w-9 items-center justify-center rounded-full hover:bg-[var(--color-surface-2)] disabled:opacity-30">
                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <button type="button" aria-label="Move down" disabled={i === sources.length - 1 || busy} onClick={() => move(i, 1)} className="flex h-11 w-9 items-center justify-center rounded-full hover:bg-[var(--color-surface-2)] disabled:opacity-30">
                    <ArrowDown className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <button type="button" aria-label={`Remove ${s.title}`} disabled={busy} onClick={() => setSources((cur) => cur.filter((x) => x.id !== s.id))} className="flex h-11 w-9 items-center justify-center rounded-full text-[var(--color-danger)] hover:bg-[var(--color-surface-2)]">
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <p className="mt-2 text-[13px] text-[var(--color-muted)]">
                {s.totalPages} {s.totalPages === 1 ? "page" : "pages"} · {s.pages.trim() ? `using pages ${s.pages}` : "using all pages"}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Input aria-label={`Pages to use from ${s.title}`} placeholder="All pages, or type e.g. 1-3, 5" value={s.pages} onChange={(e) => update(s.id, { pages: e.target.value })} disabled={busy} className="min-w-0 flex-1 sm:max-w-xs" />
                <Button type="button" variant="secondary" onClick={() => setPicking(picking === s.id ? null : s.id)}>
                  {picking === s.id ? "Done picking" : "Tap pages"}
                </Button>
              </div>
              {picking === s.id && (
                <div className="mt-3">
                  <PagePicker bytes={s.bytes} totalPages={s.totalPages} value={s.pages} onChange={(text) => update(s.id, { pages: text })} />
                </div>
              )}
            </li>
          ))}
        </ul>
        <div>
          <input ref={fileInput} type="file" accept="application/pdf,.pdf" multiple hidden onChange={onPick} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => fileInput.current?.click()} disabled={busy || sources.length >= MAX_SOURCES}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add PDFs
            </Button>
            <Link href="/print/library" className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 text-sm font-medium hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]">
              <BookOpen className="h-4 w-4" aria-hidden="true" />
              Pick from the library
            </Link>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            aria-label="Link to a PDF"
            placeholder="Or paste a link to a PDF"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={link}
            onChange={(e) => setLink(e.target.value)}
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addLink();
              }
            }}
            className="sm:flex-1"
          />
          <Button type="button" variant="secondary" pending={adding} pendingLabel="Getting the PDF..." onClick={addLink} disabled={building}>
            <Link2 className="h-4 w-4" aria-hidden="true" />
            Add link
          </Button>
        </div>
        <FormError message={addError} />
      </section>

      <section className="space-y-4">
        <h2 className="text-base font-semibold">2. Name it</h2>
        <Field label="Booklet name" htmlFor="b-title">
          <Input id="b-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} disabled={building} autoComplete="off" />
        </Field>
        <Field label="Description (optional)" htmlFor="b-desc" help="Shown under the name on the cover.">
          <Textarea id="b-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={600} rows={3} disabled={building} />
        </Field>
        <Segmented
          label="Reads from"
          value={direction}
          onChange={setDirection}
          disabled={building}
          options={[
            { value: "ltr", label: "Left to right" },
            { value: "rtl", label: "Right to left (Hebrew)" },
          ]}
          hint="Sets the cover and contents layout and which edge the booklet binds on."
        />
        <Segmented<SheetChoice>
          label="Booklet size"
          value={sheet}
          onChange={setSheet}
          disabled={building}
          options={[
            { value: "letter", label: "Letter (regular)" },
            { value: "tabloid", label: "Ledger 11x17" },
          ]}
          hint={
            sheet === "tabloid"
              ? "Full-size pages on 11x17 sheets, folded and stitched. Not tested yet: the printer's paper-size setting for this is still being checked."
              : "Each page is shrunk to half a letter sheet, folded and stitched. The usual choice."
          }
        />
        <div>
          <Checkbox label="Cover page" description="The name and description on the first page." checked={cover} onChange={(e) => setCover(e.target.checked)} disabled={building} />
          <Checkbox label="Contents page" description="Each file with the page it starts on." checked={contents} onChange={(e) => setContents(e.target.checked)} disabled={building} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">3. Build</h2>
        <p className="text-sm text-[var(--color-muted)]">Printio combines the files and takes you to the Print screen with the booklet switched on. Nothing prints until you press Print there.</p>
        <FormError message={error} />
        <Button type="submit" pending={building} pendingLabel="Building your booklet..." disabled={adding}>
          Build booklet
        </Button>
      </section>
    </form>
  );
}
