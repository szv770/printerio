"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Link2, X } from "lucide-react";
import { Button, Input, Spinner } from "@/components/ui";
import { precheckSelectedFile } from "@/lib/pdf/client-precheck";
import { importLinkAction } from "@/app/(dashboard)/print/import-link-action";
import { failureTitle, type LinkFailureCode } from "@/lib/sources/messages";
import { RECENT_LINKS_KEY, addRecent, parseRecent, recentEntry, type RecentLink } from "@/lib/sources/recent-links";
import { normalizeSourceLink } from "@/lib/sources/link";

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

const readRecent = (): RecentLink[] => {
  try {
    return parseRecent(window.localStorage.getItem(RECENT_LINKS_KEY));
  } catch {
    return []; // private window or blocked storage: the list simply starts empty
  }
};
const writeRecent = (list: RecentLink[]) => {
  try {
    window.localStorage.setItem(RECENT_LINKS_KEY, JSON.stringify(list));
  } catch {
    /* nothing to do: the list is a convenience */
  }
};

type Problem = { message: string; code?: LinkFailureCode };

/**
 * "Print from a link": paste a link to a PDF or a photo (Google Drive, Docs, Dropbox and OneDrive share links work),
 * Printio fetches it, and it appears in the Print form below exactly like a file you picked. Nothing prints until you
 * press Print. An early tool, still being tested.
 *
 * Cancel only stops WAITING: the server may still finish fetching, and that file is swept away by the daily cleanup.
 * The last five links are remembered in this browser only (see lib/sources/recent-links.ts for what is and is not kept).
 */
export function LinkImport({ maxUploadBytes }: { maxUploadBytes: number }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState("");
  const [problem, setProblem] = useState<Problem | undefined>();
  const [added, setAdded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [recent, setRecent] = useState<RecentLink[]>([]);
  const run = useRef(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  function openForm() {
    setRecent(readRecent());
    setOpen(true);
  }

  function cancel() {
    run.current++; // whatever the in-flight attempt returns is ignored from now on
    abort.current?.abort();
    setBusy(false);
    setCancelled(true);
  }

  async function fetchLink(text: string) {
    setProblem(undefined);
    setAdded(null);
    setCancelled(false);
    if (!text.trim()) {
      setProblem({ message: "Paste a link to a PDF or a photo.", code: "invalid" });
      return;
    }
    const mine = ++run.current;
    const stale = () => mine !== run.current;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    try {
      const data = new FormData();
      data.set("link", text);
      let result;
      try {
        result = await importLinkAction(data);
      } catch {
        if (!stale()) setProblem({ message: "Something went wrong on our side. Try again.", code: "try_again" });
        return;
      }
      if (stale()) return;
      if (result.error || !result.imported) {
        setProblem({ message: result.error ?? "Something went wrong. Try again.", code: result.code });
        return;
      }
      try {
        const res = await fetch(result.imported.signedUrl, { cache: "no-store", signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        if (stale()) return;
        const file = new File([blob], result.imported.fileName, { type: result.imported.contentType, lastModified: Date.now() });
        const verdict = precheckSelectedFile(file, maxUploadBytes);
        if (!verdict.ok) {
          setProblem({ message: verdict.reason });
          return;
        }
        if (!putFileInForm(file)) {
          setProblem({ message: "Printio got the file but could not add it to the form. Download it and choose it below instead." });
          return;
        }
        const parsed = normalizeSourceLink(text);
        if (parsed.ok) {
          const next = addRecent(readRecent(), recentEntry(parsed.original, result.imported.fileName, Date.now()));
          writeRecent(next);
          setRecent(next);
        }
        setAdded(result.imported.fileName);
        setLink("");
        setOpen(false);
      } catch {
        if (!stale()) setProblem({ message: "Printio got the file but your browser could not download it from Printio. Try again.", code: "try_again" });
      }
    } finally {
      if (!stale()) setBusy(false);
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    void fetchLink(link);
  }

  function reuse(entry: RecentLink) {
    if (!entry.link || busy) return;
    setLink(entry.link);
    void fetchLink(entry.link);
  }

  function forgetRecent() {
    writeRecent([]);
    setRecent([]);
  }

  function close() {
    setOpen(false);
    setProblem(undefined);
    setCancelled(false);
  }

  return (
    <div className="mb-4">
      {added && (
        <div role="status" className="mb-3 flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-success)]/25 bg-[var(--color-success-soft)] p-3.5">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden="true" />
          <p className="min-w-0 flex-1 break-words text-sm leading-5">
            Got <span className="font-semibold">{added}</span>. It is ready below: choose the pages and options, then press Print.
          </p>
          <button type="button" aria-label="Dismiss" onClick={() => setAdded(null)} className="-m-2.5 flex h-11 w-11 items-center justify-center rounded-full hover:bg-black/5">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
      {!open ? (
        <button
          type="button"
          onClick={openForm}
          className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
        >
          <Link2 className="h-4 w-4" aria-hidden="true" />
          Print from a link instead
        </button>
      ) : (
        <form onSubmit={submit} className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <label htmlFor="link-import" className="text-sm font-semibold">
            Link to a PDF or a photo
          </label>
          <p className="mt-0.5 text-[13px] leading-5 text-[var(--color-muted)]">
            A link anyone can open. Google Drive, Google Docs and Slides, Dropbox and OneDrive work when shared with &quot;Anyone with the link&quot;; so does a link straight to a PDF, JPEG or PNG. Still being tested.
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
              aria-invalid={problem ? true : undefined}
              disabled={busy}
              className="sm:flex-1"
            />
            {!busy && <Button type="submit">Get file</Button>}
          </div>
          {busy && (
            <div role="status" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <Spinner className="h-4 w-4 text-[var(--color-muted)]" />
              <span className="font-medium">Getting your file...</span>
              <span className="text-[13px] text-[var(--color-muted)]">A big file can take up to 30 seconds.</span>
              <button type="button" onClick={cancel} className="ml-auto inline-flex min-h-11 items-center rounded-full border border-[var(--color-border-strong)] px-4 text-sm font-medium hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]">
                Cancel
              </button>
            </div>
          )}
          {cancelled && !busy && !problem && (
            <p role="status" className="mt-3 text-sm text-[var(--color-muted)]">
              Stopped. Nothing was added.
            </p>
          )}
          {problem && (
            <div role="alert" className="mt-3 flex items-start gap-2 rounded-[var(--radius-card)] border border-[var(--color-danger)]/25 bg-[var(--color-danger-soft)] p-3 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-danger)]" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-semibold">{failureTitle(problem.code)}</p>
                <p className="mt-0.5 break-words leading-5">{problem.message}</p>
              </div>
            </div>
          )}
          {recent.length > 0 && !busy && (
            <div className="mt-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[13px] font-semibold text-[var(--color-muted)]">Your last links (kept in this browser only)</p>
                <button type="button" onClick={forgetRecent} className="-my-2 inline-flex min-h-11 items-center text-[13px] text-[var(--color-muted)] underline">
                  Clear
                </button>
              </div>
              <ul className="mt-1 divide-y divide-[var(--color-border)] rounded-[var(--radius-card)] border border-[var(--color-border)]">
                {recent.map((entry) => (
                  <li key={`${entry.host}|${entry.name}|${entry.at}`}>
                    {entry.link ? (
                      <button type="button" onClick={() => reuse(entry)} className="flex min-h-11 w-full flex-col items-start justify-center px-3 py-1.5 text-left hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]">
                        <span className="w-full truncate text-sm font-medium">{entry.name}</span>
                        <span className="w-full truncate text-xs text-[var(--color-muted)]">{entry.host} - tap to get it again</span>
                      </button>
                    ) : (
                      <div className="flex min-h-11 flex-col justify-center px-3 py-1.5">
                        <span className="w-full truncate text-sm">{entry.name}</span>
                        <span className="w-full truncate text-xs text-[var(--color-muted)]">{entry.host} - its link has a private key, so paste it again</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button type="button" onClick={close} className="mt-3 inline-flex min-h-11 items-center text-sm text-[var(--color-muted)] underline" disabled={busy}>
            Close
          </button>
        </form>
      )}
    </div>
  );
}
