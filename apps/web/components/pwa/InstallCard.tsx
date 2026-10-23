"use client";

import { useState } from "react";
import { Download, Share } from "lucide-react";
import { LogoMark } from "@/components/shell/Logo";
import { Button } from "@/components/ui";
import { dismissInstallCard, promptInstall } from "@/lib/pwa/install-prompt";
import type { InstallMode } from "@/lib/pwa/install";
import { useInstallMode } from "./useInstallFacts";

const IOS_STEPS = "To install: tap Share, then Add to Home Screen.";
const IOS_NO_SHARE = "Sharing files into Printio is not supported on iPhone yet. You can still pick a PDF inside Printio.";

/**
 * "Put Printio on your home screen". `card` is the big dismissible one on the teacher home; `row` is a menu line for
 * the Me sheet and the admin sidebar (no dismiss button, so it ignores an earlier "Not now").
 * Android / Chrome / Chromebook get a real Install button (the browser's own dialog). iPhone and iPad get the
 * manual steps, and a plain statement that sharing into Printio does not work there. `previewMode` is for the dev preview only.
 */
export function InstallCard({
  variant = "card",
  rowClassName = "",
  previewMode,
}: {
  variant?: "card" | "row";
  rowClassName?: string;
  previewMode?: InstallMode;
}) {
  const real = useInstallMode({ ignoreDismissed: variant === "row" });
  const mode = previewMode ?? real;
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  if (mode === "hidden") return null;

  async function install() {
    setBusy(true);
    try {
      await promptInstall();
    } finally {
      setBusy(false);
    }
  }

  if (variant === "row") {
    return (
      <div>
        <button
          type="button"
          disabled={busy}
          aria-expanded={mode === "ios" ? open : undefined}
          onClick={() => (mode === "ios" ? setOpen((o) => !o) : void install())}
          className={
            rowClassName ||
            "flex min-h-12 w-full items-center gap-3 rounded-[var(--radius-control)] px-3 text-[15px] font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:shadow-[var(--ring)] disabled:opacity-55"
          }
        >
          <Download className="h-5 w-5 shrink-0 text-[var(--color-muted)]" strokeWidth={1.75} aria-hidden="true" />
          Install Printio
        </button>
        {mode === "ios" && open && (
          <p className="px-3 pb-2 text-sm leading-5 text-[var(--color-text-2)]">
            {IOS_STEPS} <span className="text-[var(--color-muted)]">{IOS_NO_SHARE}</span>
          </p>
        )}
      </div>
    );
  }

  return (
    <section
      aria-label="Install Printio"
      className="mb-5 flex gap-3.5 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)]"
    >
      <LogoMark size={44} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-bold tracking-[-0.01em]">Keep Printio on your home screen</h2>
        {mode === "prompt" ? (
          <>
            <p className="mt-1 text-sm leading-5 text-[var(--color-text-2)]">
              It opens like an app. Then in Files, Drive or Gmail, tap Share and choose Printio to send a PDF here.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void install()} pending={busy} pendingLabel="Opening...">
                <Download className="h-4 w-4" aria-hidden="true" />
                Install Printio
              </Button>
              <Button size="sm" variant="ghost" onClick={dismissInstallCard}>
                Not now
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm leading-5 text-[var(--color-text-2)]">
              To install: tap Share
              <Share className="ml-1 inline h-4 w-4 align-[-3px] text-[var(--color-primary)]" aria-hidden="true" />, then Add to Home Screen.
            </p>
            <p className="mt-1.5 text-sm leading-5 text-[var(--color-muted)]">{IOS_NO_SHARE}</p>
            <div className="mt-3">
              <Button size="sm" variant="ghost" onClick={dismissInstallCard}>
                Got it
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
