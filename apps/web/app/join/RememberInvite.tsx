"use client";

import { useEffect } from "react";

/** Remembers the invite code for an hour so it survives the emailed sign-in
 *  link even if the link's own address loses it. Cookie only holds the code. */
export function RememberInvite({ code }: { code: string }) {
  useEffect(() => {
    try {
      document.cookie = `printio_invite=${encodeURIComponent(code)}; path=/; max-age=3600; samesite=lax`;
    } catch {
      // Cookies blocked: the code in the link still works.
    }
  }, [code]);
  return null;
}
