"use client";

import { useActionState } from "react";
import { Globe } from "lucide-react";
import { Button, Textarea, FieldLabel, FormError, Card, Badge } from "@/components/ui";
import { updateAllowedDomainsAction, initialSettingsActionState } from "./actions";

export function SettingsPanel({
  allowedDomains,
  canManage,
}: {
  allowedDomains: string[];
  canManage: boolean;
}) {
  const [state, formAction, pending] = useActionState(updateAllowedDomainsAction, initialSettingsActionState);

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
          <form action={formAction} className="flex flex-col gap-3">
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
            <FormError message={state.error} />
            <div>
              <Button type="submit" size="sm" pending={pending} pendingLabel="Saving...">
                Save
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
