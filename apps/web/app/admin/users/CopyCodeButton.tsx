"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** Small copy-to-clipboard affordance next to an enrollment code - used both
 *  right after a code is created (InviteForm) and next to every open
 *  invitation in the roster page's list (InvitationsList). Codes are meant to
 *  be shared out-of-band (see actions.ts), so retyping a 12-character string
 *  by hand was the only option before this. No toast library exists in this
 *  app, so "Copied" is a brief inline state flip instead. */
export function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. insecure context, permission denied) -
      // the code is still visible right next to this button to copy by hand.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 text-xs text-[var(--color-primary)] hover:underline"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
