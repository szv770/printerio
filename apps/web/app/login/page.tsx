import { Card } from "@/components/ui";
import { SignInButton } from "./SignInButton";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
      <Card className="w-full max-w-sm text-center shadow-sm">
        <h1 className="mb-2 text-2xl font-semibold">PrintOS</h1>
        <p className="mb-4 text-sm text-[var(--color-muted)]">Sign in to upload and track print jobs.</p>
        {reason === "reauth_required" && (
          <p className="mb-4 rounded-lg border border-[var(--color-warning)] px-3 py-2 text-sm text-[var(--color-warning)]">
            For your security, please sign in again - it&apos;s been more than 30 days since your last sign-in.
          </p>
        )}
        <SignInButton />
      </Card>
    </main>
  );
}
