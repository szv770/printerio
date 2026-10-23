"use client";

import { useActionState } from "react";
import Link from "next/link";
import { UserX } from "lucide-react";
import { Badge, Button, Collapsible, FormError } from "@/components/ui";
import { routes } from "@/lib/routes";
import { removeSignupAction, type RemoveSignupState } from "./actions";
import type { UnmatchedSignup } from "@/lib/admin/unmatched-signups";

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const fmt = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : "Never");

export function UnmatchedSignups({ signups }: { signups: UnmatchedSignup[] }) {
  return (
    <div className="mt-6">
      <Collapsible
        id="signups"
        title="Sign-ups without access"
        icon={<UserX className="h-4 w-4" />}
        summary={signups.length === 0 ? "No one is waiting" : `${signups.length} ${signups.length === 1 ? "person" : "people"} signed up but can't see anything`}
        badge={signups.length > 0 ? <Badge tone="warning">{signups.length}</Badge> : undefined}
      >
        <p className="mb-3 text-sm text-[var(--color-text-2)]">
          These people created a sign-in but aren&apos;t in any organization, so they can&apos;t see or print anything. To let one in,{" "}
          <Link href={routes.adminInvites} className="text-[var(--color-primary)] hover:underline">
            send them an invite
          </Link>
          . If you don&apos;t recognise someone, remove them.
        </p>
        {signups.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">Nothing here. Everyone who signed up is a member.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {signups.map((s) => (
              <SignupRow key={s.userId} signup={s} />
            ))}
          </ul>
        )}
      </Collapsible>
    </div>
  );
}

const initial: RemoveSignupState = {};

function SignupRow({ signup }: { signup: UnmatchedSignup }) {
  const [state, action, pending] = useActionState(removeSignupAction, initial);
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="break-all text-sm font-medium text-[var(--color-text)]">{signup.email}</p>
        <p className="text-[13px] text-[var(--color-muted)]">
          Signed up {fmt(signup.signedUpAt)} &middot; Last sign-in {fmt(signup.lastSignInAt)}
        </p>
        {state.error && <FormError message={state.error} />}
      </div>
      <form
        action={action}
        onSubmit={(e) => {
          if (!confirm(`Remove ${signup.email}? Their sign-in is deleted. They can sign up again, but will see nothing until invited.`)) e.preventDefault();
        }}
      >
        <input type="hidden" name="userId" value={signup.userId} />
        <Button type="submit" variant="outline-danger" disabled={pending} aria-label={`Remove ${signup.email}`}>
          {pending ? "Removing..." : "Remove"}
        </Button>
      </form>
    </li>
  );
}
