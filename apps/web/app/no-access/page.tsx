import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { RedeemForm } from "./RedeemForm";

export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string; domain?: string }>;
}) {
  const { reason, domain } = await searchParams;

  // Domain-restriction rejection (docs/architecture.md sec 19): the user was
  // already signed back out in app/auth/callback/route.ts before landing
  // here, so there is deliberately no session to check below - this branch
  // must render on its own, for a signed-out visitor, with a specific
  // explanation rather than a generic "no access" message.
  if (reason === "domain_not_allowed") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
        <div>
          <h1 className="text-xl font-semibold">This organization only accepts certain email domains</h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            {domain ? (
              <>
                Your email&apos;s domain (<strong>{domain}</strong>) isn&apos;t on the list of domains this
                organization allows to sign in.
              </>
            ) : (
              <>Your email&apos;s domain isn&apos;t on the list of domains this organization allows to sign in.</>
            )}{" "}
            You&apos;ve been signed out. If you believe this is a mistake, ask your organization administrator to
            add your domain under Admin &rarr; Settings.
          </p>
        </div>
      </main>
    );
  }

  const session = await getCurrentSession();
  if (!session) redirect(routes.login);
  if (session.membership) redirect(routes.home);

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
