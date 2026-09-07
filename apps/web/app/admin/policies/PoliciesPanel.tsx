"use client";

import { useActionState, useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { Tables } from "@/lib/database.types";
import { Button, Input, Select, Textarea, FieldLabel, FormError, Badge, EmptyState, Card } from "@/components/ui";
import {
  createPolicyAction,
  createPolicyRuleAction,
  toggleRuleEnabledAction,
  initialPolicyActionState,
} from "./actions";

type Policy = Tables<"print_policies">;
type Rule = Tables<"policy_rules">;

export function PoliciesPanel({ policies, rules, canManage }: { policies: Policy[]; rules: Rule[]; canManage: boolean }) {
  const [createState, createAction, creating] = useActionState(createPolicyAction, initialPolicyActionState);

  return (
    <div className="flex flex-col gap-6" data-tour="admin-policies-panel">
      {canManage && (
        <Card>
          <form action={createAction} className="flex items-end gap-3">
            <div>
              <FieldLabel htmlFor="policyName">New policy name</FieldLabel>
              <Input id="policyName" name="name" required placeholder="Staff Policy" />
            </div>
            <Button type="submit" size="sm" pending={creating} pendingLabel="Creating...">
              Create policy
            </Button>
            <FormError message={createState.error} />
          </form>
        </Card>
      )}

      {policies.map((policy) => (
        <PolicyCard key={policy.id} policy={policy} rules={rules.filter((r) => r.policy_id === policy.id)} canManage={canManage} />
      ))}
      {policies.length === 0 && (
        <EmptyState message="No policies yet - the organization default action applies to every job." icon={ShieldCheck} />
      )}
    </div>
  );
}

const ACTION_TONE: Record<string, "success" | "warning" | "danger"> = {
  allow: "success",
  require_approval: "warning",
  deny: "danger",
};

function PolicyCard({ policy, rules, canManage }: { policy: Policy; rules: Rule[]; canManage: boolean }) {
  const [showNewRule, setShowNewRule] = useState(false);
  const [ruleState, ruleAction, rulePending] = useActionState(createPolicyRuleAction, initialPolicyActionState);
  const [toggleState, toggleAction] = useActionState(toggleRuleEnabledAction, initialPolicyActionState);

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <p className="font-medium">{policy.name}</p>
        {canManage && (
          <button type="button" onClick={() => setShowNewRule((v) => !v)} className="text-xs font-medium text-[var(--color-primary)]">
            + Add rule
          </button>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {rules.map((rule) => (
          <li key={rule.id} className="rounded bg-gray-50 p-3 text-sm">
            <div className="flex items-center justify-between">
              <Badge tone={ACTION_TONE[rule.action] ?? "neutral"}>{rule.action}</Badge>
              {canManage && (
                <form action={toggleAction}>
                  <input type="hidden" name="ruleId" value={rule.id} />
                  <input type="hidden" name="enabled" value={String(rule.enabled)} />
                  <button type="submit" className="text-xs text-[var(--color-muted)] underline">
                    {rule.enabled ? "disable" : "enable"}
                  </button>
                </form>
              )}
            </div>
            <p className="mt-1">{rule.reason_label}</p>
            <pre className="mt-1 overflow-x-auto rounded bg-white p-2 text-xs">{JSON.stringify(rule.conditions)}</pre>
          </li>
        ))}
        {rules.length === 0 && <p className="text-xs text-[var(--color-muted)]">No rules in this policy.</p>}
      </ul>
      <FormError message={toggleState.error} />

      {showNewRule && (
        <form action={ruleAction} className="mt-3 flex flex-col gap-2 rounded-lg border border-[var(--color-border)] p-3 text-sm">
          <input type="hidden" name="policyId" value={policy.id} />
          <Select name="action">
            <option value="require_approval">require_approval</option>
            <option value="allow">allow</option>
            <option value="deny">deny</option>
          </Select>
          <Input name="reasonLabel" placeholder="Reason shown to approvers/users" required />
          <Input name="priority" type="number" defaultValue={100} />
          <Textarea name="conditions" rows={3} defaultValue='[{"field":"page_count","operator":"gt","value":20}]' />
          <Button type="submit" pending={rulePending} pendingLabel="Saving...">
            Add rule
          </Button>
          <FormError message={ruleState.error} />
        </form>
      )}
    </Card>
  );
}
