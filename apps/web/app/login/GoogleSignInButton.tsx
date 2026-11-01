"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";
import { googleErrorMessage, googleRedirectTo } from "@/lib/auth/google";

/**
 * Sign in with any Google account. Signing in does not grant access by itself: someone with no membership lands on the
 * "You need an invite" page (finishSignIn), exactly like an unknown email. Needs the Google provider switched on in Supabase.
 */
export function GoogleSignInButton({ inviteCode }: { inviteCode?: string } = {}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function start() {
    setPending(true);
    setError(undefined);
    const { error: oauthError } = await createClient().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: googleRedirectTo(window.location.origin, inviteCode) },
    });
    if (oauthError) {
      setPending(false);
      setError(googleErrorMessage(oauthError.message));
    }
    // On success the browser is already navigating to Google; leave the button disabled.
  }

  return (
    <div>
      <Button type="button" variant="outline" className="w-full" onClick={start} disabled={pending} aria-describedby={error ? "google-error" : undefined}>
        {pending ? "Opening Google..." : "Sign in with Google"}
      </Button>
      {error && (
        <p id="google-error" role="alert" className="mt-1.5 text-center text-xs text-[var(--color-warning)]">
          {error}
        </p>
      )}
    </div>
  );
}
