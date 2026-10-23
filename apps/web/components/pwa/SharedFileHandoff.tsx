"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Smartphone, X } from "lucide-react";
import { createIndexedDbStore, purgeOldEntries, takeSharedEntry, type InboxStore } from "@/lib/pwa/inbox";
import { isValidShareId, shareNotice, SHARE_MAX_BYTES } from "@/lib/pwa/share";
import { precheckSelectedFile } from "@/lib/pdf/client-precheck";

type View = { kind: "none" } | { kind: "shared"; name: string } | { kind: "problem"; text: string };

const FILE_INPUT_ID = "file";

/**
 * The receiving end of "Share -> Printio". Sits above the Print form. When the page was opened with ?shared=<id> it
 * takes that PDF out of the share inbox (IndexedDB), puts it into the form's existing file input (so the form's own
 * page count, thumbnail and checks run exactly as if the person had picked the file), and says so. ?share=<problem>
 * explains in plain words why a share did not arrive. It never submits anything: the person reviews and presses Print.
 *
 * The props exist for the dev preview only; the real page passes just `maxUploadBytes`.
 */
export function SharedFileHandoff({
  maxUploadBytes,
  sharedId,
  shareCode,
  store,
  keepUrl = false,
}: {
  maxUploadBytes: number;
  sharedId?: string | null;
  shareCode?: string | null;
  store?: InboxStore | null;
  keepUrl?: boolean;
}) {
  const [view, setView] = useState<View>({ kind: "none" });
  const started = useRef<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = sharedId !== undefined ? sharedId : params.get("shared");
    const code = shareCode !== undefined ? shareCode : params.get("share");
    const inbox = store !== undefined ? store : createIndexedDbStore();
    const key = `${id ?? ""}|${code ?? ""}`;
    if (started.current === key) return; // React strict mode runs effects twice in development; take the file once.
    started.current = key;

    void (async () => {
      // Forget forgotten shares on every visit to this page.
      await purgeOldEntries(inbox, Date.now());

      if (!keepUrl && (params.has("shared") || params.has("share"))) {
        params.delete("shared");
        params.delete("share");
        const qs = params.toString();
        window.history.replaceState(window.history.state, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
      }

      if (code) {
        const text = shareNotice(code, SHARE_MAX_BYTES);
        if (text) setView({ kind: "problem", text });
        return;
      }
      if (!id) return;
      if (!isValidShareId(id)) {
        setView({ kind: "problem", text: "That shared file is no longer here. Share it again, or choose it below." });
        return;
      }

      const result = await takeSharedEntry(inbox, id, Date.now());
      if (result.status === "unavailable") {
        setView({ kind: "problem", text: "Your browser would not give Printio the shared file. Choose it with the button below instead." });
        return;
      }
      if (result.status === "missing") {
        setView({ kind: "problem", text: "That shared file is no longer here. Share it again, or choose it below." });
        return;
      }

      const { entry } = result;
      const file = new File([entry.blob], entry.name, { type: "application/pdf", lastModified: entry.at });
      // The form's picker rejects oversized / empty files with its own message; say the same thing here rather than
      // announcing a file the form will refuse.
      const verdict = precheckSelectedFile(file, maxUploadBytes);
      if (!verdict.ok) {
        setView({ kind: "problem", text: verdict.reason });
        return;
      }

      const input = await findFileInput();
      if (!input) {
        setView({ kind: "problem", text: "Printio could not add the shared file. Choose it with the button below instead." });
        return;
      }
      try {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        // Same event the browser fires when someone picks a file, so the form's own handler runs unchanged.
        input.dispatchEvent(new Event("change", { bubbles: true }));
        setView({ kind: "shared", name: entry.name });
      } catch {
        setView({ kind: "problem", text: "Printio could not add the shared file. Choose it with the button below instead." });
      }
    })();
  }, [maxUploadBytes, sharedId, shareCode, store, keepUrl]);

  if (view.kind === "none") return null;

  if (view.kind === "problem") {
    return (
      <div
        role="alert"
        className="mb-4 flex items-start gap-2.5 rounded-[var(--radius-card)] border border-[var(--color-warning)]/30 bg-[var(--color-warning-soft)] p-3.5 text-sm text-[var(--color-warning-ink)]"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="min-w-0 flex-1 leading-5">{view.text}</p>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setView({ kind: "none" })}
          className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-black/5 focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-primary)]/25 bg-[var(--color-primary-soft)] p-3.5"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface)] text-[var(--color-primary)]">
        <Smartphone className="h-[18px] w-[18px]" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold leading-5 text-[var(--color-text)]">Shared from your phone: {view.name}</p>
        <p className="mt-0.5 text-sm leading-5 text-[var(--color-text-2)]">It is ready below. Check the options, then press Print.</p>
      </div>
    </div>
  );
}

/** The form is a sibling that mounts in the same commit; wait a few frames in case it is not in the DOM yet. */
async function findFileInput(): Promise<HTMLInputElement | null> {
  for (let i = 0; i < 20; i++) {
    const el = document.getElementById(FILE_INPUT_ID);
    if (el instanceof HTMLInputElement && el.type === "file") return el;
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  }
  return null;
}
