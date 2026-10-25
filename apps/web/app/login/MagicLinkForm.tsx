"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button, Input, FieldLabel, FormError } from "@/components/ui";
import { routes } from "@/lib/routes";

// Deliberately conservative, same spirit as lib/auth/domains.ts's
// DOMAIN_PATTERN - just enough to catch an obviously-not-an-email typo
// before round-tripping to Supabase, never a full RFC-5322 validator.
// signInWithOtp() itself never tells the client whether the email is
// disallowed or doesn't exist (Supabase's OTP API doesn't leak that), so
// there is nothing more precise to validate against here anyway - the real
// access decision happens later, at app/auth/callback/route.ts, when the
// emailed link is actually clicked.
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sign in with a Supabase magic link (email OTP) - the second sign-in
 *  method alongside Google (SignInButton.tsx), whose per-organization
 *  allowed_domains gate can independently be relaxed for magic-link only via
 *  organizations.magic_link_requires_allowed_domain (app/admin/settings,
 *  supabase/migrations/0014_*.sql). See docs/architecture.md sec 19.3.
 *
 *  Plain client component (not a Server Action) - same as SignInButton.tsx,
 *  and for the same reason: this only calls supabase.auth.signInWithOtp()
 *  with the anon client, no server secret involved. */
export function MagicLinkForm({ inviteCode }: { inviteCode?: string } = {}) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!LOOKS_LIKE_EMAIL.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }

    setPending(true);
    setError(undefined);
    const supabase = createClient();
    const redirectTo = `${window.location.origin}${routes.authCallback}${inviteCode ? `?invite=${encodeURIComponent(inviteCode)}` : ""}`;
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: redirectTo },
    });
    setPending(false);

    if (otpError) {
      // A real failure to even attempt the request (network, rate limit) -
      // not a signal about whether the email is allowed or exists, since
      // Supabase's OTP API deliberately never reveals that to the client.
      setError(otpError.message);
      return;
    }
    setSent(true);
  }

  if (sent) {
    return <CodeEntry email={email.trim()} inviteCode={inviteCode} onBack={() => setSent(false)} />;
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 text-left">
      <div>
        <FieldLabel htmlFor="magic-link-email">Email</FieldLabel>
        <Input
          id="magic-link-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@school.org"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <FormError message={error} />
      <Button type="submit" variant={inviteCode ? "primary" : "outline"} className="w-full" pending={pending} pendingLabel="Sending...">
        Email me a sign-in link
      </Button>
    </form>
  );
}

/** After the email is sent: type the short code from it here. Works even when the emailed link was opened in a
 *  different browser window or profile (a link opened there signs in THERE; this box signs in here). */
function CodeEntry({ email, inviteCode, onBack }: { email: string; inviteCode?: string; onBack: () => void }) {
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      const res = await fetch("/auth/verify-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code, invite: inviteCode }),
      });
      const body = (await res.json().catch(() => ({}))) as { redirect?: string; error?: string };
      if (res.ok && body.redirect) {
        window.location.assign(body.redirect);
        return;
      }
      setError(body.error ?? "That didn't work. Try again.");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    }
    setPending(false);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 text-left">
      <p className="text-sm text-[var(--color-text)]">
        We emailed <strong>{email}</strong>. Open the email and tap the button, or type the code from it here.
      </p>
      <div>
        <FieldLabel htmlFor="sign-in-code">Code from the email</FieldLabel>
        <Input
          id="sign-in-code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]*"
          required
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </div>
      <FormError message={error} />
      <Button type="submit" className="w-full" pending={pending} pendingLabel="Checking...">
        Sign in
      </Button>
      <button type="button" onClick={onBack} className="text-xs text-[var(--color-muted)] underline">
        Use a different email or send a new link
      </button>
    </form>
  );
}
