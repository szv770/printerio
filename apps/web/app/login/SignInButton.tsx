"use client";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui";
import { routes } from "@/lib/routes";

export function SignInButton() {
  async function signInWithGoogle() {
    const supabase = createClient();
    const redirectTo = `${window.location.origin}${routes.authCallback}`;
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
  }

  return (
    <Button onClick={signInWithGoogle} className="w-full">
      Sign in with Google
    </Button>
  );
}
