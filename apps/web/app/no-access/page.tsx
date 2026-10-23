import { redirect } from "next/navigation";
import { KeyRound, ServerCog, TriangleAlert } from "lucide-react";
import { getCurrentSession } from "@/lib/auth/session";
import { getFirstRunStatus } from "@/lib/auth/bootstrap";
import { routes } from "@/lib/routes";
import { signOutAction } from "@/lib/auth/actions";
import { Card } from "@/components/ui";
import { RedeemForm } from "./RedeemForm";

export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string; code?: string; invite_error?: string }>;
}) {
  const { code, invite_error } = await searchParams;
  const inviteMessages: Record<string, string> = {
    not_found: "That invite isn't valid.",
    expired: "That invite has expired. Ask for a new one.",
    exhausted: "That invite has already been used the maximum number of times.",
    email_mismatch: "That invitation was made for a different email address.",
    rate_limited: "Too many tries. Please wait a few minutes and try again.",
  };

  const session = await getCurrentSession();
  if (!session) redirect(routes.login);
  if (session.membership) redirect(routes.home);

  // "Ask your organization administrator for an enrollment code" is only
  // useful advice if an administrator exists. On a deployment where no
  // organization has been created yet there is nobody to ask - the person
  // reading this screen is almost certainly the operator, and what they
  // need is the state of the bootstrap path, not a code entry box.
  const firstRun = await getFirstRunStatus();
  if (firstRun.kind !== "organization_exists") {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-4 py-12">
        <div>
          <h1 className="text-xl font-semibold">No organization has been set up on this deployment yet</h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            You&apos;re signed in as {session.email}, but this Printio deployment has no organization at all
            yet - so there is no administrator to request an enrollment code from. The first organization is
            created automatically the first time the account named by the{" "}
            <code className="font-mono">PRINTIO_BOOTSTRAP_ADMIN_EMAIL</code> environment variable signs in
            (docs/deployment.md section 3).
          </p>
        </div>

        {firstRun.kind === "bootstrap_not_configured" && (
          <Card>
            <div className="mb-2 flex items-center gap-2">
              <ServerCog className="h-4 w-4 text-[var(--color-muted)]" />
              <h2 className="text-sm font-semibold">
                This build can&apos;t see a PRINTIO_BOOTSTRAP_ADMIN_EMAIL value
              </h2>
            </div>
            <p className="mb-3 text-sm text-[var(--color-muted)]">
              Nothing will happen at sign-in until it can. If you already set it in your host&apos;s dashboard,
              the value almost certainly hasn&apos;t reached the build serving this page yet:
            </p>
            <ol className="ml-4 flex list-decimal flex-col gap-2 text-sm text-[var(--color-muted)]">
              <li>
                Set <code className="font-mono">PRINTIO_BOOTSTRAP_ADMIN_EMAIL</code> to the exact email address
                of the account that should become the first organization admin (optionally also{" "}
                <code className="font-mono">PRINTIO_BOOTSTRAP_ORG_NAME</code>).
              </li>
              <li>
                <strong>Redeploy.</strong> Environment variables are read at build time on Vercel - saving one
                does not change the deployment that is already running.
              </li>
              <li>
                Check that the redeploy actually built the commit you expect - see docs/deployment.md section
                4.1, and Admin &rarr; Settings shows the running build once you&apos;re in.
              </li>
              <li>Sign in again with that exact account.</li>
            </ol>
          </Card>
        )}

        {firstRun.kind === "bootstrap_env_invalid" && (
          <Card>
            <div className="mb-2 flex items-center gap-2">
              <TriangleAlert className="h-4 w-4 text-[var(--color-danger)]" />
              <h2 className="text-sm font-semibold">PRINTIO_BOOTSTRAP_ADMIN_EMAIL isn&apos;t a valid email address</h2>
            </div>
            <p className="text-sm text-[var(--color-muted)]">
              The variable is set on this deployment, but its value was rejected as an email address - a
              trailing space, a missing <code className="font-mono">@</code>, or a pasted{" "}
              <code className="font-mono">mailto:</code> prefix are the usual causes. Correct it, redeploy, and
              sign in again. Until then no sign-in can ever match it.
            </p>
          </Card>
        )}

        {firstRun.kind === "awaiting_bootstrap_admin" && (
          <Card>
            <div className="mb-2 flex items-center gap-2">
              <ServerCog className="h-4 w-4 text-[var(--color-muted)]" />
              <h2 className="text-sm font-semibold">A bootstrap admin is configured - this isn&apos;t that account</h2>
            </div>
            <p className="text-sm text-[var(--color-muted)]">
              This deployment has a <code className="font-mono">PRINTIO_BOOTSTRAP_ADMIN_EMAIL</code> configured,
              and signing in as exactly that account is what creates the first organization. The account you
              used ({session.email}) didn&apos;t match it, so nothing was created. Sign out and sign back in with
              the right account - or, if you believe {session.email} is the address you configured, check the
              value for a typo or stray whitespace and redeploy so the change takes effect.
            </p>
          </Card>
        )}

        <p className="text-xs text-[var(--color-muted)]">
          This screen only appears while zero organizations exist. As soon as the first one is created it is
          replaced by the ordinary enrollment-code screen, and the bootstrap path is closed permanently.
        </p>

        <div className="border-t border-[var(--color-border)] pt-4">
          <p className="text-xs text-[var(--color-muted)]">
            Signed in with the wrong account? Sign out and try again with the one that should be the bootstrap
            admin.
          </p>
          <form action={signOutAction} className="mt-2">
            <button type="submit" className="text-sm text-[var(--color-primary)] hover:underline">
              Sign out
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <KeyRound className="h-5 w-5 text-[var(--color-muted)]" />
          You need an invite
        </h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          You&apos;re signed in as <strong className="break-all text-[var(--color-text)]">{session.email}</strong>, but this
          account isn&apos;t part of the organization yet. That&apos;s expected if you haven&apos;t been invited.
        </p>
        <ul className="mt-3 flex list-disc flex-col gap-1 pl-5 text-sm text-[var(--color-muted)]">
          <li>Ask your Printio admin to send you an invite link, then open it.</li>
          <li>Already have an invite code? Enter it below.</li>
          <li>Used the wrong email? Sign out and sign in with the one you were invited on.</li>
        </ul>
      </div>
      <RedeemForm defaultCode={code && /^[A-Za-z0-9_-]{4,64}$/.test(code) ? code : ""} initialError={invite_error ? inviteMessages[invite_error] : undefined} />
      <div className="border-t border-[var(--color-border)] pt-4">
        <p className="text-xs text-[var(--color-muted)]">
          Until you&apos;re invited, this account can&apos;t see or print anything. You can sign out and try again with a
          different email.
        </p>
        <form action={signOutAction} className="mt-2">
          <button type="submit" className="text-sm text-[var(--color-primary)] hover:underline">
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
