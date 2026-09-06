"use client";

import { useActionState } from "react";
import type { Tables } from "@/lib/database.types";
import { Button, Input, FieldLabel, FormError, EmptyState } from "@/components/ui";
import {
  createAgentAction,
  rotateAgentAction,
  disableAgentAction,
  restartAgentServiceAction,
  clearAgentTempFilesAction,
  type AgentActionState,
} from "./actions";

const initialState: AgentActionState = {};

export function AgentsPanel({ agents, canManage }: { agents: Tables<"agents">[]; canManage: boolean }) {
  const [createState, createAction, createPending] = useActionState(createAgentAction, initialState);

  return (
    <div>
      {canManage && (
        <form action={createAction} className="mb-8 flex items-end gap-3 rounded-lg border border-[var(--color-border)] p-4">
          <div>
            <FieldLabel htmlFor="agentName">Agent name</FieldLabel>
            <Input id="agentName" name="name" required placeholder="Main Office PC" />
          </div>
          <Button type="submit" size="sm" pending={createPending} pendingLabel="Creating...">
            Register new agent
          </Button>
          <FormError message={createState.error} />
          {createState.enrollmentCode && (
            <p className="w-full text-sm">
              Enrollment code: <code className="rounded bg-gray-100 px-2 py-1 font-mono">{createState.enrollmentCode}</code> — valid
              24h. Run the agent&apos;s <code>register</code> command with this code on the Windows machine (see
              apps/agent/README.md).
            </p>
          )}
        </form>
      )}

      <ul className="flex flex-col gap-3">
        {agents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} canManage={canManage} />
        ))}
        {agents.length === 0 && <EmptyState message="No agents registered yet." />}
      </ul>
    </div>
  );
}

function AgentRow({ agent, canManage }: { agent: Tables<"agents">; canManage: boolean }) {
  const [rotateState, rotateAction] = useActionState(rotateAgentAction, initialState);
  const [disableState, disableAction] = useActionState(disableAgentAction, initialState);
  const [restartState, restartAction, restartPending] = useActionState(restartAgentServiceAction, initialState);
  const [clearState, clearAction, clearPending] = useActionState(clearAgentTempFilesAction, initialState);

  // Deliberately impure (Date.now()) - "online" is a snapshot at render time,
  // not a value that needs to stay referentially stable across re-renders.
  // eslint-disable-next-line react-hooks/purity
  const online = agent.last_seen_at && Date.now() - new Date(agent.last_seen_at).getTime() < 5 * 60_000;

  return (
    <li className="rounded-lg border border-[var(--color-border)] p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium">{agent.name}</p>
          <p className="text-xs text-[var(--color-muted)]">
            {agent.status} • {online ? "🟢 online" : "⚫ offline"} • v{agent.version ?? "?"}
          </p>
        </div>
        {canManage && agent.status !== "disabled" && (
          <div className="flex gap-2">
            <form action={rotateAction}>
              <input type="hidden" name="agentId" value={agent.id} />
              <Button type="submit" variant="outline" size="sm">
                Rotate credential
              </Button>
            </form>
            <form action={restartAction}>
              <input type="hidden" name="agentId" value={agent.id} />
              <Button type="submit" variant="outline" size="sm" pending={restartPending} pendingLabel="…">
                Restart service
              </Button>
            </form>
            <form action={clearAction}>
              <input type="hidden" name="agentId" value={agent.id} />
              <Button type="submit" variant="outline" size="sm" pending={clearPending} pendingLabel="…">
                Clear temp files
              </Button>
            </form>
            <form action={disableAction}>
              <input type="hidden" name="agentId" value={agent.id} />
              <Button type="submit" variant="outline-danger" size="sm">
                Disable
              </Button>
            </form>
          </div>
        )}
      </div>
      <FormError message={rotateState.error ?? disableState.error ?? restartState.error ?? clearState.error} />
      {rotateState.enrollmentCode && (
        <p className="mt-2 text-sm">
          New enrollment code: <code className="rounded bg-gray-100 px-2 py-1 font-mono">{rotateState.enrollmentCode}</code>
        </p>
      )}
    </li>
  );
}
