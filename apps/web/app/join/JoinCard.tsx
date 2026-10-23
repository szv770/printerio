import { Printer, TriangleAlert } from "lucide-react";
import { routes } from "@/lib/routes";
import { Card, ButtonLink } from "@/components/ui";
import { MagicLinkForm } from "@/app/login/MagicLinkForm";
import { GoogleComingSoon } from "@/app/login/GoogleComingSoon";
import { RememberInvite } from "./RememberInvite";

export const JOIN_PROBLEMS: Record<string, { title: string; body: string }> = {
  expired: { title: "This invite has expired", body: "Ask the person who invited you to send a new one." },
  used: { title: "This invite was already used", body: "It has reached its limit. Ask the person who invited you for a new one." },
  not_found: { title: "We can't find this invite", body: "Check that the whole link was copied, or ask for a new one." },
  rate_limited: { title: "Too many tries", body: "Please wait a few minutes and open the link again." },
};

/** The join page card: centred, with the invite already filled in. */
export function JoinCard({ code, orgName, problem }: { code?: string; orgName: string; problem?: string }) {
  const p = problem ? JOIN_PROBLEMS[problem] : undefined;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--color-bg)] px-4 py-10">
      <Card className="w-full max-w-md p-6 sm:p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
            {p ? <TriangleAlert className="h-6 w-6" aria-hidden="true" /> : <Printer className="h-6 w-6" aria-hidden="true" />}
          </span>
          {p ? (
            <>
              <h1 className="text-xl font-semibold">{p.title}</h1>
              <p className="mt-2 text-sm text-[var(--color-muted)]">{p.body}</p>
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold">
                {orgName ? `You're invited to print at ${orgName}` : "You're invited to print with Printio"}
              </h1>
              <p className="mt-2 text-sm text-[var(--color-muted)]">
                Type your email and we&apos;ll send you a sign-in link. Your invite is already filled in.
              </p>
            </>
          )}
        </div>
        {p ? (
          <ButtonLink href={routes.login} variant="outline" className="w-full">
            Go to sign in
          </ButtonLink>
        ) : (
          <div className="flex flex-col gap-4">
            {code && <RememberInvite code={code} />}
            <MagicLinkForm inviteCode={code} />
            <div className="flex items-center gap-3 text-xs text-[var(--color-muted)]">
              <div className="h-px flex-1 bg-[var(--color-border)]" />
              or
              <div className="h-px flex-1 bg-[var(--color-border)]" />
            </div>
            <GoogleComingSoon />
          </div>
        )}
      </Card>
    </main>
  );
}
