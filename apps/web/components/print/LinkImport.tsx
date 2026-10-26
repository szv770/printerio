"use client";

import { useState, useTransition } from "react";
import { Check, Link2, X } from "lucide-react";
import { Button, FormError, Input } from "@/components/ui";
import { precheckSelectedFile } from "@/lib/pdf/client-precheck";
import { importLinkAction } from "@/app/(dashboard)/print/import-link-action";

const FILE_INPUT_ID = "file";

/** Puts a file into the Print form's own file input, as if the person had picked it, so the form's page count,
 *  thumbnail, preview and checks all run unchanged (the same technique as the phone's Share -> Printio handoff). */
function putFileInForm(file: File): boolean {
  const input = document.getElementById(FILE_INPUT_ID);
  if (!(input instanceof HTMLInputElement) || input.type !== "file") return false;
  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

/**
 * "Print from a link": paste a link to a PDF (a Google Drive file works), Printio fetches it, and it appears in the
 * Print form below exactly like a file you picked. Nothing prints until you press Print. An early tool, still being tested.
 */
export function LinkImport({ maxUploadBytes }: { maxUploadBytes: number }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [added, setAdded] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    setAdded(null);
    if (!link.trim()) {
      setError("Paste a link to a PDF.");
      return;
    }
    startTransition(async () => {
      const data = new FormData();
      data.set("link", link);
      let result;
      try {
        result = await importLinkAction(data);
      } catch {
        setError("Something went wrong on our side. Try again.");
        return;
      }
      if (result.error || !result.imported) {
        setError(result.error ?? "Something went wrong. Try again.");
        return;
      }
      try {
        const res = await fetch(result.imported.signedUrl, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        const file = new File([blob], result.imported.fileName, { type: "application/pdf", lastModified: Date.now() });
        const verdict = precheckSelectedFile(file, maxUploadBytes);
        if (!verdict.ok) {
          setError(verdict.reason);
          return;
        }
        if (!putFileInForm(file)) {
          setError("Printio got the file but could not add it to the form. Download it and choose it below instead.");
          return;
        }
        setAdded(result.imported.fileName);
        setLink("");
        setOpen(false);
      } catch {
        setError("Printio got the file but your browser could not download it from Printio. Try again.");
      }
    });
  }

  return (
    <div className="mb-4">
      {added && (
        <div role="status" className="mb-3 flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-success)]/25 bg-[var(--color-success-soft)] p-3.5">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-sm leading-5">
            <span className="font-semibold">{added}</span> is ready below. Choose the pages and options, then press Print.
          </p>
          <button type="button" aria-label="Dismiss" onClick={() => setAdded(null)} className="-m-1 flex h-8 w-8 items-center justify-center rounded-full hover:bg-black/5">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
        >
          <Link2 className="h-4 w-4" aria-hidden="true" />
          Print from a link instead
        </button>
      ) : (
        <form onSubmit={submit} className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <label htmlFor="link-import" className="text-sm font-semibold">
            Link to a PDF
          </label>
          <p className="mt-0.5 text-[13px] leading-5 text-[var(--color-muted)]">
            A link anyone can open. A Google Drive file works if it is shared with &quot;Anyone with the link&quot;. Still being tested.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              id="link-import"
              name="link"
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              inputMode="url"
              placeholder="Paste the link"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              aria-invalid={error ? true : undefined}
              disabled={pending}
              className="sm:flex-1"
            />
            <Button type="submit" pending={pending} pendingLabel="Getting the PDF...">
              Get PDF
            </Button>
          </div>
          <FormError message={error} />
          <button type="button" onClick={() => (setOpen(false), setError(undefined))} className="mt-3 text-sm text-[var(--color-muted)] underline" disabled={pending}>
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}
