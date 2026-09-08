"use client";

import Link from "next/link";
import { useState, useActionState } from "react";
import { ChevronRight, Cpu, Pause, Pencil, Wifi, WifiOff } from "lucide-react";
import type { Tables } from "@/lib/database.types";
import { Button, Input, FieldLabel, FormError, EmptyState, Card, Badge } from "@/components/ui";
import { routes } from "@/lib/routes";
import {
  createAgentAction,
  rotateAgentAction,
  disableAgentAction,
  restartAgentServiceAction,
  clearAgentTempFilesAction,
  renameAgentAction,
  deleteAgentAction,
  type AgentActionState,
} from "./actions";

const initialState: AgentActionState = {};

export function AgentsPanel({ agents, canManage }: { agents: Tables<"agents">[]; canManage: boolean }) {
  const [createState, createAction, createPending] = useActionState(createAgentAction, initialState);

  return (
    <div>
      {canManage && (
        <Card className="mb-8">
          <form action={createAction} className="flex flex-wrap items-end gap-3">
            <div>
              <FieldLabel htmlFor="agentName">Agent name</FieldLabel>
              <Input id="agentName" name="name" required placeholder="Main Office PC" />
            </div>
            <Button type="submit" size="sm" pending={createPending} pendingLabel="Creating...">
              Register new agent
            </Button>
            <FormError message={createState.error} />
            {createState.enrollmentCode && (
              <p className="w-full text-sm text-[var(--color-muted)]">
                Created — its enrollment code is shown on its row in the list below (not repeated here, so
                there&apos;s only ever one place to look for it).
              </p>
            )}
          </form>
        </Card>
      )}

      <ul className="flex flex-col gap-3">
        {agents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} canManage={canManage} />
        ))}
        {agents.length === 0 && <EmptyState message="No agents registered yet." icon={Cpu} />}
      </ul>
    </div>
  );
}

function AgentRow({ agent, canManage }: { agent: Tables<"agents">; canManage: boolean }) {
  const [rotateState, rotateAction] = useActionState(rotateAgentAction, initialState);
  const [disableState, disableAction] = useActionState(disableAgentAction, initialState);
  const [restartState, restartAction, restartPending] = useActionState(restartAgentServiceAction, initialState);
  const [clearState, clearAction, clearPending] = useActionState(clearAgentTempFilesAction, initialState);
  const [renameState, renameAction, renamePending] = useActionState(renameAgentAction, initialState);
  const [deleteState, deleteAction] = useActionState(deleteAgentAction, initialState);
  const [isRenaming, setIsRenaming] = useState(false);

  // Deliberately impure (Date.now()) - "online" is a snapshot at render time,
  // not a value that needs to stay referentially stable across re-renders.
  // eslint-disable-next-line react-hooks/purity
  const online = agent.last_seen_at && Date.now() - new Date(agent.last_seen_at).getTime() < 5 * 60_000;
  // Only ever true for a status the server-side deleteAgentAction would
  // actually accept (never "active") - keeps the button from appearing
  // somewhere it's guaranteed to just bounce back with an error.
  const canDelete = canManage && agent.status !== "active";

  return (
    <li>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {/* Leading device icon, tinted by online status - gives each row a
             *  visual identity beyond its name string, and reads faster than
             *  scanning meta-line text in a long agent list. */}
            <Cpu className={`mt-0.5 h-6 w-6 shrink-0 ${online ? "text-[var(--color-success)]" : "text-[var(--color-muted)]"}`} />
            <div className="min-w-0">
              {isRenaming ? (
                <form
                  action={(formData) => {
                    renameAction(formData);
                    setIsRenaming(false);
                  }}
                  className="flex flex-wrap items-center gap-2"
                >
                  <input type="hidden" name="agentId" value={agent.id} />
                  <Input name="name" defaultValue={agent.name} required autoFocus className="h-7 py-1 text-sm" />
                  <Button type="submit" size="sm" pending={renamePending} pendingLabel="…">
                    Save
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setIsRenaming(false)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <p className="flex items-center gap-1 font-medium">
                  {agent.name}
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => setIsRenaming(true)}
                      aria-label="Rename agent"
                      className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </p>
              )}
              <p className="flex flex-wrap items-center gap-1 text-xs text-[var(--color-muted)]">
                {agent.status} •{" "}
                {online ? (
                  <>
                    <Wifi className="h-3.5 w-3.5 text-[var(--color-success)]" /> online
                  </>
                ) : (
                  <>
                    <WifiOff className="h-3.5 w-3.5" /> offline
                  </>
                )}{" "}
                • v{agent.version ?? "?"}
                {agent.hostname && <> • {agent.hostname}</>}
                {/* Paused is deliberately its own badge rather than folded into
                 *  the online/offline word: a paused Agent is connected and
                 *  healthy, it is just deliberately not taking work, and
                 *  reading that as "offline" is exactly the confusion this
                 *  whole feature exists to remove. */}
                {agent.paused && (
                  <Badge tone="warning">
                    <span className="flex items-center gap-1">
                      <Pause className="h-3 w-3" /> paused
                    </span>
                  </Badge>
                )}
              </p>
              <Link
                href={routes.adminAgentDetail(agent.id)}
                className="mt-1 inline-flex items-center gap-0.5 text-xs text-[var(--color-primary)] hover:underline"
              >
                View details
                <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {canManage && agent.status !== "disabled" && (
              <>
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
              </>
            )}
            {/* Delete is deliberately separate from the block above: it's the
             *  one action still available once an agent is "disabled" (which
             *  used to leave a disabled agent with literally no actions left
             *  at all - no way to ever remove a mistakenly-created or
             *  fully-decommissioned row). Never shown for "active" - see
             *  deleteAgentAction's own comment for why. */}
            {canDelete && (
              <form
                action={deleteAction}
                onSubmit={(e) => {
                  if (!confirm(`Permanently delete "${agent.name}"? This cannot be undone.`)) e.preventDefault();
                }}
              >
                <input type="hidden" name="agentId" value={agent.id} />
                <Button type="submit" variant="outline-danger" size="sm">
                  Delete
                </Button>
              </form>
            )}
          </div>
        </div>
        <FormError
          message={
            rotateState.error ?? disableState.error ?? restartState.error ?? clearState.error ?? renameState.error ?? deleteState.error
          }
        />
        {rotateState.enrollmentCode ? (
          <p className="mt-2 text-sm">
            New enrollment code: <code className="rounded bg-gray-100 px-2 py-1 font-mono">{rotateState.enrollmentCode}</code>
          </p>
        ) : (
          agent.status === "pending" &&
          agent.enrollment_code && (
            <p className="mt-2 text-sm">
              Enrollment code: <code className="rounded bg-gray-100 px-2 py-1 font-mono">{agent.enrollment_code}</code>
              {agent.enrollment_code_expires_at && (
                <span className="text-[var(--color-muted)]">
                  {" "}
                  — valid until {new Date(agent.enrollment_code_expires_at).toLocaleString()}
                </span>
              )}
              . Run the agent&apos;s <code>register</code> command with this code on the Windows machine (or use{" "}
              <code>setup-agent.bat</code>&apos;s prompt — see docs/agent-install.md).
            </p>
          )
        )}
      </Card>
    </li>
  );
}
