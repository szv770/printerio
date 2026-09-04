"use client";

import { useActionState } from "react";
import type { Tables } from "@/lib/database.types";
import { createAgentAction, rotateAgentAction, disableAgentAction, type AgentActionState } from "./actions";

const initialState: AgentActionState = {};

export function AgentsPanel({ agents, canManage }: { agents: Tables<"agents">[]; canManage: boolean }) {
  const [createState, createAction, createPending] = useActionState(createAgentAction, initialState);

  return (
    <div>
      {canManage && (
        <form action={createAction} className="mb-8 flex items-end gap-3 rounded-lg border border-[var(--color-border)] p-4">
          <div>
            <label className="mb-1 block text-xs font-medium">Agent name</label>
            <input name="name" required placeholder="Main Office PC" className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm" />
          </div>
          <button type="submit" disabled={createPending} className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm text-white disabled:opacity-60">
            {createPending ? "Creating..." : "Register new agent"}
          </button>
          {createState.error && <p className="text-sm text-[var(--color-danger)]">{createState.error}</p>}
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
        {agents.length === 0 && <p className="text-sm text-[var(--color-muted)]">No agents registered yet.</p>}
      </ul>
    </div>
  );
}

function AgentRow({ agent, canManage }: { agent: Tables<"agents">; canManage: boolean }) {
  const [rotateState, rotateAction] = useActionState(rotateAgentAction, initialState);
  const [disableState, disableAction] = useActionState(disableAgentAction, initialState);

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
              <button type="submit" className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs">
                Rotate credential
              </button>
            </form>
            <form action={disableAction}>
              <input type="hidden" name="agentId" value={agent.id} />
              <button type="submit" className="rounded-lg border border-[var(--color-danger)] px-3 py-1.5 text-xs text-[var(--color-danger)]">
                Disable
              </button>
            </form>
          </div>
        )}
      </div>
      {(rotateState.error || disableState.error) && (
        <p className="mt-1 text-xs text-[var(--color-danger)]">{rotateState.error ?? disableState.error}</p>
      )}
      {rotateState.enrollmentCode && (
        <p className="mt-2 text-sm">
          New enrollment code: <code className="rounded bg-gray-100 px-2 py-1 font-mono">{rotateState.enrollmentCode}</code>
        </p>
      )}
    </li>
  );
}
