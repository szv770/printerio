"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";

const FILE_INPUT_ID = "file";

/**
 * The top of the print page for ?again=<jobId>. The page has already checked the job is the person's own and its file
 * still exists, and handed over a short-lived signed link to the stored original. This fetches it (the browser never
 * uploads anything) and puts it into the Print form's own file input, exactly as BuiltBookletHandoff does, so the file
 * name, page count, preview and every rule run as for a file the person picked. The form's choices come in through
 * PrintForm's `again` prop; nothing prints until they press Print.
 */
export function PrintAgainHandoff({ banner, fileName, fileUrl }: { banner: string; fileName: string; fileUrl: string }) {
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // strict mode runs effects twice in development
    started.current = true;
    void (async () => {
      try {
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`status ${response.status}`);
        const blob = await response.blob();
        const input = document.getElementById(FILE_INPUT_ID);
        if (!(input instanceof HTMLInputElement) || input.type !== "file") throw new Error("no file input");
        const transfer = new DataTransfer();
        transfer.items.add(new File([blob], fileName, { type: "application/pdf" }));
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        setStatus("ready");
      } catch {
        setStatus("failed");
      }
    })();
  }, [fileUrl, fileName]);

  return (
    <div role="status" className="mb-4 flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-primary)]/25 bg-[var(--color-primary-soft)] p-3.5">
      <RotateCw className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm leading-5">
        <p className="break-words font-medium">{banner}</p>
        {status === "loading" && (
          <p className="mt-1 flex items-center gap-1.5 text-[var(--color-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Loading the file...
          </p>
        )}
        {status === "failed" && (
          <p className="mt-1 text-[var(--color-danger)]">The file could not be loaded here. Choose the document again below; your settings are kept.</p>
        )}
      </div>
    </div>
  );
}
