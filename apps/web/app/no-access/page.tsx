import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
import { RedeemForm } from "./RedeemForm";

export default async function NoAccessPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.membership) redirect("/");

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-xl font-semibold">You&apos;re signed in, but not in an organization yet</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Signed in as {session.email}. Ask your organization administrator for an enrollment code, or
          enter one below.
        </p>
      </div>
      <RedeemForm />
    </main>
  );
}
