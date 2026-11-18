"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Printer } from "lucide-react";
import { Button, Card, FieldLabel, FormError, Input } from "@/components/ui";
import { inviteEntryTarget } from "@/lib/auth/invite-link";
import { routes } from "@/lib/routes";
import Link from "next/link";

/** /join with no code: someone pressed "I have an invite" on the home page. They paste the invite link or the code and
 *  carry on to the normal join step. */
export function InviteEntry() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>();

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const target = inviteEntryTarget(value);
    if (!target.ok) {
      setError(target.error);
      return;
    }
    setError(undefined);
    router.push(target.href);
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--color-bg)] px-4 py-10">
      <Card className="w-full max-w-md p-6 sm:p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
            <Printer className="h-6 w-6" aria-hidden="true" />
          </span>
          <h1 className="text-xl font-semibold">Join with an invite</h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">Paste the invite link you were sent, or just the code from it.</p>
        </div>
        <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
          <div>
            <FieldLabel htmlFor="invite-entry">Invite link or code</FieldLabel>
            <Input
              id="invite-entry"
              name="invite"
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="Paste the invite link or code"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </div>
          <FormError message={error} />
          <Button type="submit" className="w-full">
            Continue
          </Button>
        </form>
        <p className="mt-5 text-center text-sm text-[var(--color-muted)]">
          Already have an account?{" "}
          <Link href={routes.login} className="font-medium text-[var(--color-primary)]">
            Sign in
          </Link>
        </p>
      </Card>
    </main>
  );
}
