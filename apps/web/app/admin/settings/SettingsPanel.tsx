"use client";

import { useActionState } from "react";
import { Globe, Mail, BookOpen, ShieldAlert, Stamp } from "lucide-react";
import { Button, Textarea, FieldLabel, FormError, FormSuccess, Card, Badge, Select } from "@/components/ui";
import {
  updateAllowedDomainsAction,
  updateMagicLinkDomainToggleAction,
  updateDefaultBookletBindingSideAction,
  updateAdminsBypassRestrictionsAction,
  updateStampSettingsAction,
  type SettingsActionState,
} from "./actions";

// A "use server" file may only export async functions, so this trivial seed
// value for useActionState lives here instead of alongside the action.
import { STAMP_SHOW_OPTIONS, STAMP_STRENGTH_OPTIONS, type StampSettings } from "@/lib/jobs/user-code";

const initialSettingsActionState: SettingsActionState = {};

export function SettingsPanel({
  allowedDomains,
  magicLinkRequiresAllowedDomain,
  defaultBookletBindingSide,
  adminsBypassRestrictions,
  stamp,
  canManage,
}: {
  allowedDomains: string[];
  magicLinkRequiresAllowedDomain: boolean;
  defaultBookletBindingSide: "left" | "right";
  adminsBypassRestrictions: boolean;
  stamp: StampSettings;
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
  const [bindingSideState, bindingSideFormAction, bindingSidePending] = useActionState(
    updateDefaultBookletBindingSideAction,
    initialSettingsActionState,
  );
  const [adminBypassState, adminBypassFormAction, adminBypassPending] = useActionState(
    updateAdminsBypassRestrictionsAction,
    initialSettingsActionState,
  );

  const [stampState, stampFormAction, stampPending] = useActionState(updateStampSettingsAction, initialSettingsActionState);

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
            <FormSuccess message={domainsState.success} />
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
            <FormSuccess message={magicLinkState.success} />
            <div>
              <Button type="submit" size="sm" pending={magicLinkPending} pendingLabel="Saving...">
                Save
              </Button>
            </div>
          </form>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-[var(--color-muted)]" />
          <h2 className="text-sm font-semibold">Default booklet binding side</h2>
        </div>
        <p className="mb-3 text-sm text-[var(--color-muted)]">
          Which edge a new booklet-capable printer profile defaults to binding on - &quot;left edge binding&quot; for
          LTR reading, &quot;right edge binding&quot; for RTL (e.g. Hebrew) reading, matching the Kyocera KX
          driver&apos;s own booklet Layout-tab terminology. Only prefills profiles created from now on (Admin →
          Printers) - it does not change any existing profile or in-flight job, and can always be overridden per
          profile or per job.
        </p>

        {!canManage && (
          <p className="text-sm text-[var(--color-muted)]">
            New booklet profiles default to{" "}
            {defaultBookletBindingSide === "right" ? "right edge binding (RTL)" : "left edge binding (LTR)"}.
          </p>
        )}

        {canManage && (
          <form action={bindingSideFormAction} className="flex flex-col gap-3">
            <div>
              <FieldLabel htmlFor="defaultBookletBindingSide">Binding side</FieldLabel>
              <Select id="defaultBookletBindingSide" name="defaultBookletBindingSide" defaultValue={defaultBookletBindingSide}>
                <option value="left">Left edge binding (LTR reading)</option>
                <option value="right">Right edge binding (RTL reading, e.g. Hebrew)</option>
              </Select>
            </div>
            <FormError message={bindingSideState.error} />
            <FormSuccess message={bindingSideState.success} />
            <div>
              <Button type="submit" size="sm" pending={bindingSidePending} pendingLabel="Saving...">
                Save
              </Button>
            </div>
          </form>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-[var(--color-muted)]" />
          <h2 className="text-sm font-semibold">Admins bypass approval &amp; quota</h2>
        </div>
        <p className="mb-3 text-sm text-[var(--color-muted)]">
          By default, an org_admin&apos;s own print jobs are never held up by a &quot;requires approval&quot; or
          &quot;denied&quot; policy outcome, or by a quota limit - there&apos;s often no one else around to approve
          an admin&apos;s own job. The job still records exactly what the rule/quota would have done, and shows it
          as a warning, rather than hiding it. Turn this off if you want your own admins held to the same rules as
          everyone else.
        </p>

        {!canManage && (
          <p className="text-sm text-[var(--color-muted)]">
            {adminsBypassRestrictions
              ? "Admins' own print jobs bypass approval and quota rules (shown as a warning when one would apply)."
              : "Admins are subject to the same approval and quota rules as everyone else."}
          </p>
        )}

        {canManage && (
          <form action={adminBypassFormAction} className="flex flex-col gap-3">
            <label className="flex items-start gap-2 text-sm text-[var(--color-text)]">
              <input
                type="checkbox"
                name="adminsBypassRestrictions"
                defaultChecked={adminsBypassRestrictions}
                className="mt-0.5"
              />
              Admin print jobs bypass approval/deny and quota blocking
            </label>
            <FormError message={adminBypassState.error} />
            <FormSuccess message={adminBypassState.success} />
            <div>
              <Button type="submit" size="sm" pending={adminBypassPending} pendingLabel="Saving...">
                Save
              </Button>
            </div>
          </form>
        )}
      </Card>
      <Card>
        <div className="mb-3 flex items-center gap-2">
          <Stamp className="h-4 w-4 text-[var(--color-muted)]" />
          <h2 className="text-sm font-semibold">Print stamp (user code)</h2>
        </div>
        <p className="mb-3 text-sm text-[var(--color-muted)]">
          Stamps a small, faint code in the bottom-right corner of page 1 of each printout, so you can walk to the
          printer and tell whose pile is whose. Every copy carries it, and so does a booklet&apos;s cover. Each
          person&apos;s code is set on the Users page. Applies to jobs created from now on.
        </p>

        {!canManage && (
          <p className="text-sm text-[var(--color-muted)]">
            {stamp.enabled
              ? `On: ${STAMP_SHOW_OPTIONS.find((o) => o.value === stamp.show)?.label.toLowerCase()}, ${stamp.strength}.`
              : "Off: print jobs are not stamped."}
          </p>
        )}

        {canManage && (
          <form action={stampFormAction} className="flex flex-col gap-3">
            <label className="flex items-start gap-2 text-sm text-[var(--color-text)]">
              <input type="checkbox" name="stampEnabled" defaultChecked={stamp.enabled} className="mt-0.5" />
              Stamp the user code on page 1 of every print job
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <FieldLabel htmlFor="stampShow">Shows</FieldLabel>
                <Select id="stampShow" name="stampShow" defaultValue={stamp.show}>
                  {STAMP_SHOW_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <FieldLabel htmlFor="stampStrength">Strength</FieldLabel>
                <Select id="stampStrength" name="stampStrength" defaultValue={stamp.strength}>
                  {STAMP_STRENGTH_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <FormError message={stampState.error} />
            <FormSuccess message={stampState.success} />
            <div>
              <Button type="submit" size="sm" pending={stampPending} pendingLabel="Saving...">
                Save
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
