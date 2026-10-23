"use client";

import { useState } from "react";
import { Check, Link2, Share2 } from "lucide-react";
import { buildInviteUrl, inviteShareMessage } from "@/lib/auth/invite-link";

const BTN =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[var(--radius-control)] px-3.5 text-[13px] font-medium focus-visible:shadow-[var(--ring)] focus-visible:outline-none";

/** Shares a friendly invite message with a link that pre-fills the code.
 *  Uses the phone/desktop share sheet when there is one, else copies the message. */
export function ShareInviteButton({ code, orgName }: { code: string; orgName: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function handleShare() {
    const url = buildInviteUrl(window.location.origin, code);
    const text = inviteShareMessage(orgName, url);
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "Printio invite", text });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return; // person closed the sheet
        // anything else: fall back to copying
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2500);
  }

  return (
    <span className="inline-flex flex-col">
      <button type="button" onClick={handleShare} className={`${BTN} bg-[var(--color-primary)] text-white hover:opacity-90`}>
        {state === "copied" ? <Check className="h-4 w-4" aria-hidden="true" /> : <Share2 className="h-4 w-4" aria-hidden="true" />}
        {state === "copied" ? "Message copied" : "Share invite"}
      </button>
      <span role="status" className="sr-only">
        {state === "copied" ? "Invite message copied. Paste it into a chat or email." : state === "failed" ? "Could not copy." : ""}
      </span>
      {state === "failed" && <span className="mt-1 text-xs text-[var(--color-danger)]">Couldn&apos;t copy. Copy the code by hand.</span>}
    </span>
  );
}

/** Copies just the link (for people who prefer to paste it themselves). */
export function CopyLinkButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  async function handle() {
    try {
      await navigator.clipboard.writeText(buildInviteUrl(window.location.origin, code));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked
    }
  }
  return (
    <button
      type="button"
      onClick={handle}
      className={`${BTN} border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-primary)] hover:bg-[var(--color-surface-2)]`}
    >
      {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Link2 className="h-4 w-4" aria-hidden="true" />}
      {copied ? "Link copied" : "Copy link"}
    </button>
  );
}
