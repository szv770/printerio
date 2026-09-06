"use client";

import { useActionState } from "react";
import { Globe, Mail } from "lucide-react";
import { Button, Textarea, FieldLabel, FormError, Card, Badge } from "@/components/ui";
import {
  updateAllowedDomainsAction,
  updateMagicLinkDomainToggleAction,
  initialSettingsActionState,
} from "./actions";

export function SettingsPanel({
  allowedDomains,
  magicLinkRequiresAllowedDomain,
  canManage,
}: {
  allowedDomains: string[];
  magicLinkRequiresAllowedDomain: boolean;
  canManage: boolean;
}) {
  const [domainsState, domainsFormAction, domainsPending] = useActionState(
    updateAllowedDomainsAction,
    initialSettingsActionState,
  );
  const [magicLinkState, magicLinkFormAction, magicLinkPending] = useActionState(
    updateMagicLinkDomainToggleAction,
    initialSettingsActionState,
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="mb-3 flex items-center gap-2">
          <Globe className="h-4 w-4 text-[var(--color-muted)]" />
          <h2 className="text-sm font-semibold">Allowed sign-in domains</h2>
        </div>
        <p className="mb-3 text-sm text-[var(--color-muted)]">
          Only email addresses on these domains may sign in as a brand-new user (an existing member can always
          sign in, regardless of this list). Leave empty to allow any domain to attempt to join - actual
          membership still requires an enrollment code either way.
        </p>

        {!canManage && (
          <div className="mb-3 flex flex-wrap gap-2">
            {allowedDomains.length === 0 ? (
              <span className="text-sm text-[var(--color-muted)]">No restriction configured (any domain).</span>
            ) : (
              allowedDomains.map((d) => <Badge key={d}>{d}</Badge>)
            )}
          </div>
        )}

        {canManage && (
          <form action={domainsFormAction} className="flex flex-col gap-3">
            <div>
              <FieldLabel htmlFor="domains" hint="one per line, or comma-separated">
                Domains
              </FieldLabel>
              <Textarea
                id="domains"
                name="domains"
                rows={4}
                defaultValue={allowedDomains.join("\n")}
                placeholder={"lecfl.com\nstaff.lecfl.com"}
              />
            </div>
            <FormError message={domainsState.error} />
            <div>
              <Button type="submit" size="sm" pending={domainsPending} pendingLabel="Saving...">
                Save
              </Button>
            </div>
          </form>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex items-center gap-2">
          <Mail className="h-4 w-4 text-[var(--color-muted)]" />
          <h2 className="text-sm font-semibold">Magic-link sign-in</h2>
        </div>
        <p className="mb-3 text-sm text-[var(--color-muted)]">
          Email sign-in links (app/login) are a second way to sign in, alongside Google. By default a
          brand-new user requesting one is checked against the allowed domains above, the same as Google
          sign-in always is. Turning this off lets anyone with any email address request a magic link - though,
          same as Google, they still need an invitation or enrollment code to actually join the organization.
        </p>

        {!canManage && (
          <p className="text-sm text-[var(--color-muted)]">
            {magicLinkRequiresAllowedDomain
              ? "Magic-link sign-in is restricted to the allowed domains above."
              : "Magic-link sign-in is open to any email domain."}
          </p>
        )}

        {canManage && (
          <form action={magicLinkFormAction} className="flex flex-col gap-3">
            <label className="flex items-start gap-2 text-sm text-[var(--color-text)]">
              <input
                type="checkbox"
                name="magicLinkRequiresAllowedDomain"
                defaultChecked={magicLinkRequiresAllowedDomain}
                className="mt-0.5"
              />
              Require magic-link sign-in to match the allowed domains above
            </label>
            <FormError message={magicLinkState.error} />
            <div>
              <Button type="submit" size="sm" pending={magicLinkPending} pendingLabel="Saving...">
                Save
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
