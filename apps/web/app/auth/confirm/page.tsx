import { Card } from "@/components/ui";
import { routes } from "@/lib/routes";

// The sign-in email links HERE, not straight to the callback. Opening this page spends nothing: the one-time token is
// only used when the person presses the button. Email scanners and link previews fetch links without pressing buttons,
// so they can no longer use up the link before the person does.
export const dynamic = "force-dynamic";

export default async function ConfirmSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string; type?: string; invite?: string }>;
}) {
  const { token_hash, type, invite } = await searchParams;
  const valid = !!token_hash && /^[A-Za-z0-9_-]{8,200}$/.test(token_hash);
  const params = new URLSearchParams();
  if (valid) {
    params.set("token_hash", token_hash);
    params.set("type", type === "magiclink" ? "magiclink" : "email");
    if (invite && /^[A-Za-z0-9_-]{4,64}$/.test(invite)) params.set("invite", invite);
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4">
      <Card className="w-full max-w-sm text-center shadow-sm">
        <h1 className="mb-2 text-2xl font-semibold">Printio</h1>
        {valid ? (
          <>
            <p className="mb-4 text-sm text-[var(--color-muted)]">
              You&apos;re one tap away. Press the button to finish signing in on this device.
            </p>
            {/* A plain link on purpose: no script needed, and nothing happens until it is pressed. */}
            <a
              href={`${routes.authCallback}?${params.toString()}`}
              className="block w-full rounded-xl bg-[var(--color-primary)] px-4 py-3 text-center font-medium text-white"
            >
              Sign in to Printio
            </a>
            <p className="mt-4 text-xs text-[var(--color-muted)]">
              Started signing in in another window? Close this one and type the code from the email there instead.
            </p>
          </>
        ) : (
          <>
            <p role="alert" className="mb-4 text-sm text-[var(--color-warning)]">
              That sign-in link is incomplete. Request a new one.
            </p>
            <a href={routes.login} className="text-sm underline">Back to sign in</a>
          </>
        )}
      </Card>
    </main>
  );
}
