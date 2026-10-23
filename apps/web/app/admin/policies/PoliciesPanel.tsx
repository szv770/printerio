"use client";

import { useActionState, useState } from "react";
import { Check, HelpCircle, Plus, ShieldCheck } from "lucide-react";
import type { Tables } from "@/lib/database.types";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Collapsible,
  EmptyState,
  Field,
  FieldError,
  FormError,
  Input,
  SAVE_BAR_CLEARANCE,
  SaveBar,
  Segmented,
  Select,
  Switch,
} from "@/components/ui";
import { roleLabel } from "@/lib/role-label";
import { buildConditions, ruleSentence, type ColorChoice, type NameLookups, type RuleAction } from "@/lib/admin/rules";
import {
  createPolicyAction,
  createPolicyRuleAction,
  toggleRuleEnabledAction,
  type PolicyActionState,
} from "./actions";

// A "use server" file may only export async functions, so this trivial seed
// value for useActionState lives here instead of alongside the action.
const initialPolicyActionState: PolicyActionState = {};

type Policy = Tables<"print_policies">;
type Rule = Tables<"policy_rules">;

const ACTION_BADGE: Record<string, { label: string; tone: "success" | "warning" | "danger" }> = {
  allow: { label: "Allowed", tone: "success" },
  require_approval: { label: "Needs approval", tone: "warning" },
  deny: { label: "Not allowed", tone: "danger" },
};

function conditionsOf(rule: Rule) {
  return Array.isArray(rule.conditions) ? (rule.conditions as Array<{ field: string; operator: string; value: unknown }>) : [];
}

export function PoliciesPanel({
  policies,
  rules,
  canManage,
  groupNames = {},
}: {
  policies: Policy[];
  rules: Rule[];
  canManage: boolean;
  /** group id -> name, so a rule can say "from the Science group". */
  groupNames?: Record<string, string>;
}) {
  const [createState, createAction, creating] = useActionState(createPolicyAction, initialPolicyActionState);

  // One SaveBar for every switch on the page. `saved` holds values that were
  // saved this visit (so the baseline moves on without waiting for new props);
  // `drafts` holds the switches that differ from that baseline right now.
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const baselineOf = (r: Rule) => saved[r.id] ?? r.enabled;
  const enabledOf = (r: Rule) => drafts[r.id] ?? baselineOf(r);
  const changed = rules.filter((r) => enabledOf(r) !== baselineOf(r));
  const lookups: NameLookups = { groupName: (id) => groupNames[id] };

  function flip(rule: Rule, next: boolean) {
    setDrafts((d) => {
      const copy = { ...d };
      if (next === baselineOf(rule)) delete copy[rule.id];
      else copy[rule.id] = next;
      return copy;
    });
    setErrors((e) => {
      if (!(rule.id in e)) return e;
      const copy = { ...e };
      delete copy[rule.id];
      return copy;
    });
  }

  async function save() {
    if (saving || changed.length === 0) return;
    setSaving(true);
    setErrors({});
    const nextErrors: Record<string, string> = {};
    const nextSaved = { ...saved };
    const nextDrafts = { ...drafts };
    for (const rule of changed) {
      const fd = new FormData();
      fd.set("ruleId", rule.id);
      fd.set("enabled", String(baselineOf(rule))); // the action flips whatever it is told the rule is now
      try {
        const res = await toggleRuleEnabledAction({}, fd);
        if (res.error) nextErrors[rule.id] = res.error;
        else {
          nextSaved[rule.id] = enabledOf(rule);
          delete nextDrafts[rule.id];
        }
      } catch {
        nextErrors[rule.id] = "Couldn't save. Check your connection and try again.";
      }
    }
    setSaved(nextSaved);
    setDrafts(nextDrafts);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) setSavedAt((n) => (n ?? 0) + 1);
    setSaving(false);
  }

  function discard() {
    setDrafts({});
    setErrors({});
  }

  const failed = Object.keys(errors).length;
  const barError = failed > 0 ? (failed === 1 ? "One change couldn't be saved. The others were saved." : `${failed} changes couldn't be saved. The others were saved.`) : null;

  return (
    <div className={`flex flex-col gap-6 ${canManage ? SAVE_BAR_CLEARANCE : ""}`} data-tour="admin-policies-panel">
      {!canManage && (
        <p className="rounded-[var(--radius-control)] bg-[var(--color-surface-2)] px-4 py-3 text-sm text-[var(--color-text-2)]">
          You can look at these rules, but only an admin can change them.
        </p>
      )}

      {policies.map((policy) => {
        const own = rules.filter((r) => r.policy_id === policy.id);
        return (
          <section key={policy.id} aria-labelledby={`policy-${policy.id}`} className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id={`policy-${policy.id}`} className="text-lg font-semibold leading-7">
                {policy.name}
              </h2>
              <span className="text-[13px] text-[var(--color-muted)]">{own.length === 1 ? "1 rule" : `${own.length} rules`}</span>
            </div>
            <Card className="p-0 sm:p-0">
              {own.length === 0 ? (
                <p className="px-4 py-5 text-sm text-[var(--color-muted)] sm:px-5">No rules here yet.</p>
              ) : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {own.map((rule) => {
                    const on = enabledOf(rule);
                    const badge = ACTION_BADGE[rule.action] ?? { label: rule.action, tone: "warning" as const };
                    return (
                      <li key={rule.id} className="px-4 py-1.5 sm:px-5">
                        <Switch
                          label={<span className={on ? "" : "text-[var(--color-muted)]"}>{ruleSentence({ action: rule.action, conditions: conditionsOf(rule) }, lookups)}</span>}
                          description={
                            <span className="mt-1 inline-flex items-center gap-2">
                              <Badge tone={on ? badge.tone : "neutral"}>{badge.label}</Badge>
                              {!on && <span>Off</span>}
                            </span>
                          }
                          checked={on}
                          onChange={(e) => flip(rule, e.target.checked)}
                          disabled={!canManage || saving}
                        />
                        <FieldError message={errors[rule.id]} />
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
            {canManage && <AddRule policyId={policy.id} groupNames={groupNames} />}
          </section>
        );
      })}

      {policies.length === 0 && (
        <EmptyState
          icon={ShieldCheck}
          title="No print rules yet"
          description="Without rules, every job follows your default setting."
        />
      )}

      {canManage && (
        <Collapsible
          id="new-policy"
          title="New set of rules"
          summary="Group rules together, for example one set for staff"
          icon={<Plus className="h-4 w-4" />}
        >
          <form action={createAction} className="flex flex-col gap-3">
            <Field label="Name" htmlFor="policyName">
              <Input id="policyName" name="name" required placeholder="Staff rules" />
            </Field>
            <FormError message={createState.error} />
            <div>
              <Button type="submit" pending={creating} pendingLabel="Creating...">
                Create
              </Button>
            </div>
          </form>
        </Collapsible>
      )}

      <Collapsible id="how-rules-work" title="How rules work" icon={<HelpCircle className="h-4 w-4" />}>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-[var(--color-text-2)]">
          <li>A job is checked against every rule that is switched on.</li>
          <li>If any rule says a job is not allowed, it is stopped.</li>
          <li>Otherwise, if any rule says it needs approval, an approver has to say yes first.</li>
          <li>A rule only applies when everything in it fits the job.</li>
          <li>Switch a rule off to pause it without losing it.</li>
        </ul>
      </Collapsible>

      {canManage && (
        <SaveBar
          dirty={changed.length > 0}
          saving={saving}
          savedAt={savedAt}
          error={barError}
          onSave={() => void save()}
          onDiscard={discard}
        />
      )}
    </div>
  );
}

const ACTION_OPTIONS = [
  { value: "require_approval" as const, label: "Needs approval" },
  { value: "allow" as const, label: "Allow" },
  { value: "deny" as const, label: "Block" },
];

/** The "Add a rule" form: a few plain choices, a live sentence, and nothing else. */
function AddRule({ policyId, groupNames }: { policyId: string; groupNames: Record<string, string> }) {
  const [action, setAction] = useState<RuleAction>("require_approval");
  const [color, setColor] = useState<ColorChoice>("any");
  const [pagesOver, setPagesOver] = useState("");
  const [copiesOver, setCopiesOver] = useState("");
  const [role, setRole] = useState("any");
  const [stapled, setStapled] = useState(false);
  const [added, setAdded] = useState(false);

  const conditions = buildConditions({ color, pagesOver, copiesOver, role, stapled });
  const sentence = ruleSentence({ action, conditions }, { groupName: (id) => groupNames[id] });

  const [state, formAction, pending] = useActionState(async (prev: PolicyActionState, fd: FormData) => {
    const res = await createPolicyRuleAction(prev, fd);
    if (!res.error) {
      setColor("any");
      setPagesOver("");
      setCopiesOver("");
      setRole("any");
      setStapled(false);
    }
    setAdded(!res.error);
    return res;
  }, initialPolicyActionState);

  const id = `rule-${policyId}`;
  return (
    <Collapsible id={`add-${policyId}`} title="Add a rule" summary="Pick what to look for and what should happen" icon={<Plus className="h-4 w-4" />}>
      <form action={formAction} className="flex flex-col gap-5" onChange={() => setAdded(false)}>
        <input type="hidden" name="policyId" value={policyId} />
        <input type="hidden" name="action" value={action} />
        <input type="hidden" name="reasonLabel" value={sentence} />
        <input type="hidden" name="priority" value="100" />
        <input type="hidden" name="conditions" value={JSON.stringify(conditions)} />

        <Segmented label="What should happen?" value={action} onChange={setAction} options={ACTION_OPTIONS} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Color" htmlFor={`${id}-color`}>
            <Select id={`${id}-color`} value={color} onChange={(e) => setColor(e.target.value as ColorChoice)}>
              <option value="any">Any</option>
              <option value="color">Color only</option>
              <option value="bw">Black and white only</option>
            </Select>
          </Field>
          <Field label="Who prints" htmlFor={`${id}-role`}>
            <Select id={`${id}-role`} value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="any">Anyone</option>
              <option value="student">{roleLabel("student")}s</option>
              <option value="staff">{roleLabel("staff")}</option>
              <option value="approver">{roleLabel("approver")}s</option>
              <option value="org_admin">{roleLabel("org_admin")}s</option>
            </Select>
          </Field>
          <Field label="More than this many pages" htmlFor={`${id}-pages`}>
            <Input id={`${id}-pages`} inputMode="numeric" value={pagesOver} onChange={(e) => setPagesOver(e.target.value.replace(/\D/g, ""))} placeholder="20" />
          </Field>
          <Field label="More than this many copies" htmlFor={`${id}-copies`}>
            <Input id={`${id}-copies`} inputMode="numeric" value={copiesOver} onChange={(e) => setCopiesOver(e.target.value.replace(/\D/g, ""))} placeholder="10" />
          </Field>
        </div>
        <Checkbox label="Only jobs with staples" checked={stapled} onChange={(e) => setStapled(e.target.checked)} />

        <div className="rounded-[var(--radius-control)] bg-[var(--color-primary-soft)] px-4 py-3 text-sm" aria-live="polite">
          <p className="text-[13px] text-[var(--color-muted)]">This rule says</p>
          <p className="mt-0.5 font-medium text-[var(--color-text)]">{conditions.length === 0 ? "Pick at least one thing to look for." : sentence}</p>
        </div>

        <FormError message={state.error} />
        {added && !state.error && (
          <p className="flex items-center gap-2 text-sm font-medium text-[var(--color-success)]">
            <Check className="h-4 w-4" aria-hidden="true" /> Rule added
          </p>
        )}
        <div>
          <Button type="submit" pending={pending} pendingLabel="Adding..." disabled={conditions.length === 0}>
            Add rule
          </Button>
        </div>
      </form>
    </Collapsible>
  );
}
