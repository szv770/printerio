"use client";

import { useState } from "react";
import { BookOpen, LogIn, ShieldCheck, Stamp } from "lucide-react";
import {
  Collapsible,
  Field,
  FieldError,
  SAVE_BAR_CLEARANCE,
  SaveBar,
  Select,
  Switch,
  Textarea,
  useDirtyForm,
} from "@/components/ui";
import {
  updateAllowedDomainsAction,
  updateDefaultBookletBindingSideAction,
  updateAdminsBypassRestrictionsAction,
  updateStampSettingsAction,
  updateAutoRetryFailedPrintsAction,
  type SettingsActionState,
} from "./actions";
import { STAMP_SHOW_OPTIONS, STAMP_STRENGTH_OPTIONS, type StampSettings } from "@/lib/jobs/user-code";
import {
  ACTION_FIELDS,
  ACTION_SECTION,
  actionFormFields,
  adminsSummary,
  dirtyActions,
  printingSummary,
  sectionsWithErrors,
  signInSummary,
  stampSummary,
  type SettingsActionId,
  type SettingsValues,
} from "@/lib/settings-form";

// The existing server actions are unchanged; the unified Save calls each one
// that has changes, in this order, with exactly the form fields it always read.
const ACTIONS: Record<SettingsActionId, (prev: SettingsActionState, fd: FormData) => Promise<SettingsActionState>> = {
  domains: updateAllowedDomainsAction,
  bindingSide: updateDefaultBookletBindingSideAction,
  adminBypass: updateAdminsBypassRestrictionsAction,
  autoRetry: updateAutoRetryFailedPrintsAction,
  stamp: updateStampSettingsAction,
};

const ACTION_LABEL: Record<SettingsActionId, string> = {
  domains: "Who can join",
  bindingSide: "Booklet binding side",
  adminBypass: "Admin exceptions",
  autoRetry: "Automatic retry",
  stamp: "Print stamp",
};

type Errors = Partial<Record<SettingsActionId, string>>;

export function SettingsPanel({
  allowedDomains,
  joinMode,
  domainJoinRole,
  defaultBookletBindingSide,
  adminsBypassRestrictions,
  autoRetryFailedPrints,
  stamp,
  canManage,
}: {
  allowedDomains: string[];
  joinMode: "invite_only" | "invite_or_domain";
  domainJoinRole: "student" | "staff";
  defaultBookletBindingSide: "left" | "right";
  adminsBypassRestrictions: boolean;
  autoRetryFailedPrints: boolean;
  stamp: StampSettings;
  canManage: boolean;
}) {
  const form = useDirtyForm<SettingsValues>({
    domains: allowedDomains.join("\n"),
    joinMode,
    domainJoinRole,
    bindingSide: defaultBookletBindingSide,
    adminsBypass: adminsBypassRestrictions,
    autoRetry: autoRetryFailedPrints,
    stampEnabled: stamp.enabled,
    stampShow: stamp.show,
    stampStrength: stamp.strength,
  });
  const v = form.values;

  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const pendingActions = dirtyActions(form.baseline, v);
  const sectionErrors = sectionsWithErrors(errors);
  const failedCount = Object.values(errors).filter(Boolean).length;

  function change<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) {
    form.set(key, value);
    // Editing a field with a server error clears that error.
    setErrors((prev) => {
      const next = { ...prev };
      for (const a of Object.keys(ACTION_FIELDS) as SettingsActionId[]) {
        if (ACTION_FIELDS[a].includes(key)) delete next[a];
      }
      return next;
    });
  }

  async function save() {
    if (saving || pendingActions.length === 0) return;
    setSaving(true);
    setErrors({});
    const nextErrors: Errors = {};
    const savedKeys: Array<keyof SettingsValues> = [];
    for (const action of pendingActions) {
      const fd = new FormData();
      for (const [k, val] of Object.entries(actionFormFields(action, v))) fd.set(k, val);
      try {
        const res = await ACTIONS[action]({}, fd);
        if (res.error) nextErrors[action] = res.error;
        else savedKeys.push(...ACTION_FIELDS[action]);
      } catch {
        nextErrors[action] = `Couldn't save "${ACTION_LABEL[action]}". Check your connection and try again.`;
      }
    }
    if (savedKeys.length > 0) form.commit(savedKeys);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) setSavedAt((n) => (n ?? 0) + 1);
    setSaving(false);
  }

  function discard() {
    form.reset();
    setErrors({});
  }

  const dis = !canManage;
  const barError =
    failedCount > 0
      ? failedCount === 1
        ? "One change couldn't be saved. The other changes were saved."
        : `${failedCount} changes couldn't be saved. Any others were saved.`
      : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      noValidate
      className={`flex flex-col gap-4 ${canManage ? SAVE_BAR_CLEARANCE : ""}`}
    >
      {!canManage && (
        <p className="rounded-[var(--radius-control)] bg-[var(--color-surface-2)] px-4 py-3 text-sm text-[var(--color-text-2)]">
          You can look at these settings, but only an admin can change them.
        </p>
      )}

      <Collapsible
        id="signin"
        title="Who can join"
        icon={<LogIn className="h-4 w-4" />}
        summary={signInSummary(v)}
        forceOpen={sectionErrors.has("signin")}
      >
        <div className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-2" aria-describedby="joinMode-desc">
            <legend className="mb-1.5 text-[13px] font-medium leading-5 text-[var(--color-text)]">Who can join this organization</legend>
            <JoinChoice
              value="invite_only"
              checked={v.joinMode === "invite_only"}
              onChange={() => change("joinMode", "invite_only")}
              disabled={dis}
              title="Invitation only"
              description="Only people you invite (a link or a code) can join. Safest."
            />
            <JoinChoice
              value="invite_or_domain"
              checked={v.joinMode === "invite_or_domain"}
              onChange={() => change("joinMode", "invite_or_domain")}
              disabled={dis}
              title="Invitation, or a school email"
              description="Anyone who signs in with a verified email on a domain below joins automatically. Everyone else still needs an invitation."
            />
            <div id="joinMode-desc">
              <FieldError message={errors.domains} />
            </div>
          </fieldset>

          <Field
            label="School email domains"
            hint="one per line"
            htmlFor="domains"
            help={
              v.joinMode === "invite_or_domain"
                ? "Only the exact domain matches: lecfl.com does not include mail.lecfl.com or evil-lecfl.com, so list each one you want. Others can still be let in with an invitation."
                : "Saved for later. These only take effect if you choose \"Invitation, or a school email\" above."
            }
          >
            <Textarea
              id="domains"
              name="domains"
              rows={3}
              value={v.domains}
              onChange={(e) => change("domains", e.target.value)}
              placeholder={"lecfl.com"}
              disabled={dis}
              invalid={!!errors.domains}
              aria-describedby="domains-desc"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>

          <Field
            label="People who join by school email become"
            htmlFor="domainJoinRole"
            help="Admins and approvers are never created this way; you promote them yourself."
          >
            <Select
              id="domainJoinRole"
              name="domainJoinRole"
              value={v.domainJoinRole}
              onChange={(e) => change("domainJoinRole", e.target.value === "staff" ? "staff" : "student")}
              disabled={dis || v.joinMode !== "invite_or_domain"}
              aria-describedby="domainJoinRole-desc"
            >
              <option value="student">Students</option>
              <option value="staff">Staff</option>
            </Select>
          </Field>

          <p className="rounded-[var(--radius-control)] bg-[var(--color-surface-2)] px-3 py-2.5 text-[13px] text-[var(--color-text-2)]">
            Someone outside these rules can still create a sign-in, but they see nothing and can&apos;t print until you invite them
            (Users &rarr; Invite). People who are already members are never affected by this setting.
          </p>
        </div>
      </Collapsible>

      <Collapsible
        id="printing"
        title="Printing defaults"
        icon={<BookOpen className="h-4 w-4" />}
        summary={printingSummary(v)}
        forceOpen={sectionErrors.has("printing")}
      >
        <div className="flex flex-col gap-5">
          <Field
            label="Booklet binding side"
            htmlFor="bindingSide"
            help="Which edge new booklet printer setups start with. Right edge is for right-to-left reading such as Hebrew. Printers and jobs that already exist are not changed."
            error={errors.bindingSide}
          >
            <Select
              id="bindingSide"
              name="defaultBookletBindingSide"
              value={v.bindingSide}
              onChange={(e) => change("bindingSide", e.target.value === "right" ? "right" : "left")}
              disabled={dis}
              invalid={!!errors.bindingSide}
              aria-describedby="bindingSide-desc"
            >
              <option value="left">Left edge (left-to-right reading)</option>
              <option value="right">Right edge (right-to-left reading, such as Hebrew)</option>
            </Select>
          </Field>
          <div>
            <Switch
              label="Try failed prints again automatically"
              description="If a print fails (printer offline, paper jam, print computer restarted), Printio sends it again by itself a few times, then leaves it failed with a plain explanation. When this is off, the teacher sees what went wrong and presses Try again."
              checked={v.autoRetry}
              onChange={(e) => change("autoRetry", e.target.checked)}
              disabled={dis}
            />
            <FieldError message={errors.autoRetry} />
          </div>
        </div>
      </Collapsible>

      <Collapsible
        id="stamp"
        title="Print stamp"
        icon={<Stamp className="h-4 w-4" />}
        summary={stampSummary(v)}
        forceOpen={sectionErrors.has("stamp")}
      >
        <div className="flex flex-col gap-5">
          <Switch
            label="Stamp a code on page 1 of every print"
            description="A small, faint code in the bottom-right corner, so you can tell at the printer whose pile is whose. Booklet covers and every copy carry it. Each person's code is set on the Users page. Applies to new jobs only."
            checked={v.stampEnabled}
            onChange={(e) => change("stampEnabled", e.target.checked)}
            disabled={dis}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="What it shows" htmlFor="stampShow">
              <Select
                id="stampShow"
                name="stampShow"
                value={v.stampShow}
                onChange={(e) => change("stampShow", e.target.value)}
                disabled={dis}
                invalid={!!errors.stamp}
              >
                {STAMP_SHOW_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="How dark" htmlFor="stampStrength">
              <Select
                id="stampStrength"
                name="stampStrength"
                value={v.stampStrength}
                onChange={(e) => change("stampStrength", e.target.value)}
                disabled={dis}
                invalid={!!errors.stamp}
              >
                {STAMP_STRENGTH_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <FieldError message={errors.stamp} />
        </div>
      </Collapsible>

      <Collapsible
        id="admins"
        title="Admin exceptions"
        icon={<ShieldCheck className="h-4 w-4" />}
        summary={adminsSummary(v)}
        forceOpen={sectionErrors.has("admins")}
      >
        <div>
          <Switch
            label="Admins skip approval and limits for their own prints"
            description="There is often nobody else around to approve an admin's own print. Their jobs still show a warning when a rule or limit would have applied. Turn this off to hold admins to the same rules as everyone else."
            checked={v.adminsBypass}
            onChange={(e) => change("adminsBypass", e.target.checked)}
            disabled={dis}
          />
          <FieldError message={errors.adminBypass} />
        </div>
      </Collapsible>

      {canManage && (
        <SaveBar
          dirty={pendingActions.length > 0}
          saving={saving}
          savedAt={savedAt}
          error={barError}
          changeCount={new Set(pendingActions.map((a) => ACTION_SECTION[a])).size}
          onSave={() => void save()}
          onDiscard={discard}
        />
      )}
    </form>
  );
}

function JoinChoice({
  value,
  checked,
  onChange,
  disabled,
  title,
  description,
}: {
  value: string;
  checked: boolean;
  onChange: () => void;
  disabled: boolean;
  title: string;
  description: string;
}) {
  return (
    <label
      className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-[var(--radius-control)] border px-3 py-3 transition-colors has-[:focus-visible]:shadow-[var(--ring)] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 ${
        checked ? "border-[var(--color-primary)] bg-[var(--color-surface-2)]" : "border-[var(--color-border-strong)] hover:border-[var(--color-faint)]"
      }`}
    >
      <input
        type="radio"
        name="joinMode"
        value={value}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-[var(--color-primary)] disabled:cursor-not-allowed"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium leading-5 text-[var(--color-text)]">{title}</span>
        <span className="mt-0.5 block text-[13px] text-[var(--color-muted)]">{description}</span>
      </span>
    </label>
  );
}
