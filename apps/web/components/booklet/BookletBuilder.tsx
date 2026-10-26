"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, FileText, Link2, Plus, Trash2 } from "lucide-react";
import { Button, Checkbox, Field, FormError, Input, Segmented, Textarea } from "@/components/ui";
import { PagePicker } from "@/components/print/PagePicker";
import { precheckSelectedFile } from "@/lib/pdf/client-precheck";
import { putBuiltBooklet } from "@/lib/booklet/handoff";
import { importLinkAction } from "@/app/(dashboard)/print/import-link-action";
import { buildBookletAction } from "@/app/(dashboard)/print/booklet/actions";

const MAX_SOURCES = 12;

interface Source {
  id: number;
  title: string;
  file: File;
  bytes: ArrayBuffer;
  totalPages: number;
  /** Typed range, "" = every page. The page picker edits this same text. */
  pages: string;
  credit: string;
}

const nameFromFile = (n: string) => n.replace(/\.pdf$/i, "").replace(/_+/g, " ").trim();

/** Builds one PDF from several (cover, contents, the chosen pages of each), then opens the normal Print page with it. */
export function BookletBuilder({ maxUploadBytes }: { maxUploadBytes: number }) {
  const router = useRouter();
  const nextId = useRef(1);
  const fileInput = useRef<HTMLInputElement>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [direction, setDirection] = useState<"ltr" | "rtl">("ltr");
  const [cover, setCover] = useState(true);
  const [contents, setContents] = useState(true);
  const [link, setLink] = useState("");
  const [addError, setAddError] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [adding, startAdd] = useTransition();
  const [building, startBuild] = useTransition();
  const [picking, setPicking] = useState<number | null>(null);

  async function addFile(file: File, credit = "") {
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
    setSources((cur) => [...cur, { id: nextId.current++, title: nameFromFile(file.name), file, bytes, totalPages, pages: "", credit }]);
  }

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
        router.push(`/print?built=1&booklet=${direction === "rtl" ? "right" : "left"}`);
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
        {sources.length === 0 && (
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
          <Button type="button" variant="secondary" onClick={() => fileInput.current?.click()} disabled={busy || sources.length >= MAX_SOURCES}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add PDFs
          </Button>
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
