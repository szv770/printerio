"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Download, X } from "lucide-react";
import { takeBuiltBooklet } from "@/lib/booklet/handoff";

const FILE_INPUT_ID = "file";

/**
 * The receiving end of the booklet builder. When the page is opened with ?built=1 it takes the finished booklet PDF from
 * memory and puts it into the Print form's own file input, so the preview, the blank pages note, finishing choices and the
 * printing rules all run exactly as for a file the person picked. Nothing prints until they press Print.
 */
export function BuiltBookletHandoff() {
  const [view, setView] = useState<{ kind: "ok"; name: string; url: string; booklet: boolean } | { kind: "gone" } | null>(null);
  const started = useRef(false);
  const objectUrl = useRef<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("built") || started.current) return; // strict mode runs effects twice in development
    started.current = true;
    const asBooklet = params.has("booklet");
    params.delete("built");
    const qs = params.toString();
    window.history.replaceState(window.history.state, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
    // Deferred a tick so the Print form's file input exists and state is not set inside the effect body.
    void Promise.resolve().then(() => {
      const file = takeBuiltBooklet();
      const input = document.getElementById(FILE_INPUT_ID);
      if (!file || !(input instanceof HTMLInputElement) || input.type !== "file") {
        setView({ kind: "gone" });
        return;
      }
      try {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        objectUrl.current = URL.createObjectURL(file);
      setView({ kind: "ok", name: file.name, url: objectUrl.current, booklet: asBooklet });
      } catch {
        setView({ kind: "gone" });
      }
    });
    return () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, []);

  if (!view) return null;
  return (
    <div role="status" className="mb-4 flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-success)]/25 bg-[var(--color-success-soft)] p-3.5">
      <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm leading-5">
        {view.kind === "ok" ? (
          <>
            <span className="font-semibold">{view.name}</span>{" "}
            {view.booklet ? "is ready below as a booklet. Check the preview, then press Print." : "is ready below. Choose the pages and options, then press Print."}
            {view.booklet && (
              <>
                {" "}
                <a href={view.url} download={view.name} className="inline-flex items-center gap-1 font-medium underline">
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  Save a copy (PDF)
                </a>{" "}
                <span className="text-[var(--color-muted)]">This is the normal page-by-page PDF, not the folded layout, so you can upload it again later.</span>
              </>
            )}
          </>
        ) : (
          <>That booklet is no longer here (the page was reloaded). Go back to the booklet builder and build it again.</>
        )}
      </p>
      <button type="button" aria-label="Dismiss" onClick={() => setView(null)} className="-m-1 flex h-8 w-8 items-center justify-center rounded-full hover:bg-black/5">
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
