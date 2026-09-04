"use client";

import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  async function signInWithGoogle() {
    const supabase = createClient();
    const redirectTo = `${window.location.origin}/auth/callback`;
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
      <div className="w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center shadow-sm">
        <h1 className="mb-2 text-2xl font-semibold">PrintOS</h1>
        <p className="mb-8 text-sm text-[var(--color-muted)]">Sign in to upload and track print jobs.</p>
        <button
          onClick={signInWithGoogle}
          className="w-full rounded-lg bg-[var(--color-primary)] px-4 py-3 text-base font-medium text-[var(--color-primary-fg)] hover:opacity-90"
        >
          Sign in with Google
        </button>
      </div>
    </main>
  );
}
