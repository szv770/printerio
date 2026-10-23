"use client";

import { useEffect, useState } from "react";
import { FileUp } from "lucide-react";
import { InstallCard } from "@/components/pwa/InstallCard";
import { PendingShareBanner } from "@/components/pwa/PendingShareBanner";
import { SharedFileHandoff } from "@/components/pwa/SharedFileHandoff";
import { INBOX_DB_NAME, INBOX_STORE_NAME } from "@/lib/pwa/inbox";

/** Dev preview only: the install card variants and the "shared from your phone" handoff, fed with a REAL IndexedDB entry. */

const PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";

function seed(id: string, name: string, at: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(INBOX_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(INBOX_STORE_NAME, { keyPath: "id" });
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction(INBOX_STORE_NAME, "readwrite");
      const blob = new Blob([PDF], { type: "application/pdf" });
      tx.objectStore(INBOX_STORE_NAME).put({ id, name, size: blob.size, blob, at });
      tx.oncomplete = () => {
        req.result.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

/** What the real PrintForm does with the file input: here a stand-in that only shows what arrived. */
function FakeFileInput() {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="relative flex min-h-28 items-center gap-4 rounded-[var(--radius-card)] border-2 border-dashed border-[var(--color-primary)]/40 bg-[var(--color-surface)] p-5">
      <input
        id="file"
        type="file"
        name="file"
        className="absolute inset-0 z-10 h-full w-full opacity-0"
        onChange={(e) => setPicked(e.target.files?.[0] ? `${e.target.files[0].name} (${e.target.files[0].size} bytes, ${e.target.files[0].type})` : null)}
      />
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
        <FileUp className="h-7 w-7" aria-hidden="true" />
      </span>
      <p data-testid="picked" className="min-w-0 flex-1 break-words text-sm">
        {picked ? `File input now holds: ${picked}` : "Choose a PDF (stand-in for the print form's file input)"}
      </p>
    </div>
  );
}

export function PwaPreviewSection({ variant = "shared" }: { variant?: string }) {
  const [ready, setReady] = useState(false);
  const seeded = variant === "shared" || variant === "old";
  const pending = variant === "pendinghome" || variant === "pendinglogin";

  useEffect(() => {
    if (!seeded && !pending) return;
    // "old" seeds an entry two hours old: the page must refuse it, like a stale share.
    const at = variant === "old" ? Date.now() - 2 * 3600_000 : Date.now();
    void seed("11111111-2222-3333-4444-555555555555", "Grade 7 science quiz - unit 4 (final).pdf", at).then(() => setReady(true));
  }, [seeded, pending, variant]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      {pending && ready && <PendingShareBanner where={variant === "pendinglogin" ? "login" : "home"} />}
      {variant === "android" && <InstallCard previewMode="prompt" />}
      {variant === "ios" && <InstallCard previewMode="ios" />}
      {variant === "rows" && (
        <div className="rounded-[var(--radius-card)] bg-[var(--color-surface)] p-2 shadow-[var(--shadow-card)]">
          <InstallCard variant="row" previewMode="prompt" />
          <InstallCard variant="row" previewMode="ios" />
        </div>
      )}
      {(seeded ? ready : ["toolarge", "notpdf", "notready", "missing", "unavailable"].includes(variant)) && (
        <>
          <SharedFileHandoff
            maxUploadBytes={52428800}
            keepUrl
            {...(variant === "shared" || variant === "old" ? { sharedId: "11111111-2222-3333-4444-555555555555" } : {})}
            {...(variant === "toolarge" || variant === "notpdf" || variant === "notready" ? { shareCode: variant } : {})}
            {...(variant === "missing" ? { sharedId: "99999999-0000-0000-0000-000000000000" } : {})}
            {...(variant === "unavailable" ? { sharedId: "99999999-0000-0000-0000-000000000000", store: null } : {})}
          />
          <FakeFileInput />
        </>
      )}
    </main>
  );
}

