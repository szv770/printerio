"use client";

import { createClient } from "@/lib/supabase/client";
import { Button, Card } from "@/components/ui";
import { routes } from "@/lib/routes";

export default function LoginPage() {
  async function signInWithGoogle() {
    const supabase = createClient();
    const redirectTo = `${window.location.origin}${routes.authCallback}`;
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
      <Card className="w-full max-w-sm text-center shadow-sm">
        <h1 className="mb-2 text-2xl font-semibold">PrintOS</h1>
        <p className="mb-8 text-sm text-[var(--color-muted)]">Sign in to upload and track print jobs.</p>
        <Button onClick={signInWithGoogle} className="w-full">
          Sign in with Google
        </Button>
      </Card>
    </main>
  );
}
