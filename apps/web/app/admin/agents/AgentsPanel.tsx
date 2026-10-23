"use client";

import Link from "next/link";
import { useState, useActionState } from "react";
import { ChevronRight, Cpu, Pencil, Plus } from "lucide-react";
import type { Tables } from "@/lib/database.types";
import { Button, Collapsible, EmptyState, Field, FormError, Input, StatusDot, buttonClass } from "@/components/ui";
import { routes } from "@/lib/routes";
import { describeAgentConnection } from "@/lib/agent-detail";
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
    <div className="flex flex-col gap-4">
      {agents.length === 0 ? (
        <EmptyState
          title="No print servers yet"
          message="A print server is the small program on the Windows computer that sends jobs to your printers."
          icon={Cpu}
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} canManage={canManage} />
          ))}
        </ul>
      )}

      {canManage && (
        <Collapsible
          id="add-server"
          title="Add a print server"
          icon={<Plus className="h-4 w-4" />}
          summary="Register another Windows computer"
          forceOpen={!!createState.error}
        >
          <form action={createAction} className="flex flex-col gap-4 sm:max-w-md">
            <Field label="Name" htmlFor="agentName" hint="for example the room it is in">
              <Input id="agentName" name="name" required placeholder="Main office PC" />
            </Field>
            <div>
              <Button type="submit" pending={createPending} pendingLabel="Creating..." className="w-full sm:w-auto">
                Add print server
              </Button>
            </div>
            <FormError message={createState.error} />
            {createState.enrollmentCode && (
              <p className="text-sm text-[var(--color-text-2)]">
                Added. Its setup code is on its card in the list above.
              </p>
            )}
          </form>
        </Collapsible>
      )}
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
  const connection = describeAgentConnection(agent, Date.now());
  const tone = connection.tone;
  // Only ever true for a status the server-side deleteAgentAction would
  // actually accept (never "active") - keeps the button from appearing
  // somewhere it's guaranteed to just bounce back with an error.
  const canDelete = canManage && agent.status !== "active";
  const error =
    rotateState.error ?? disableState.error ?? restartState.error ?? clearState.error ?? renameState.error ?? deleteState.error;
  const setupCode = rotateState.enrollmentCode ?? (agent.status === "pending" ? agent.enrollment_code : null);

  return (
    <li>
      <Collapsible
        id={`server-${agent.id}`}
        title={agent.name}
        icon={<Cpu className="h-4 w-4" />}
        summary={[connection.label, agent.version ? `version ${agent.version}` : null, agent.hostname].filter(Boolean).join(", ")}
        badge={<StatusDot tone={tone}>{connection.label}</StatusDot>}
        forceOpen={!!error || !!setupCode}
      >
        <p className="mb-4 text-sm text-[var(--color-text-2)]">{connection.detail}</p>

        {setupCode && (
          <div className="mb-4 rounded-[var(--radius-control)] bg-[var(--color-warning-soft)] px-4 py-3 text-sm text-[var(--color-warning-ink)]">
            <p className="font-medium">Setup code</p>
            <code className="font-mono text-lg font-semibold tracking-widest break-all">{setupCode}</code>
            {!rotateState.enrollmentCode && agent.enrollment_code_expires_at && (
              <p className="mt-1 text-[13px]">Works until {new Date(agent.enrollment_code_expires_at).toLocaleString()}.</p>
            )}
            <p className="mt-1 text-[13px]">
              Enter this code on the Windows computer: run the print server&apos;s <code>register</code> command, or use the prompt in{" "}
              <code>setup-agent.bat</code>.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Link href={routes.adminAgentDetail(agent.id)} className={buttonClass("primary", "sm")}>
            Open details <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          {canManage && !isRenaming && (
            <Button type="button" variant="secondary" size="sm" onClick={() => setIsRenaming(true)}>
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Rename
            </Button>
          )}
        </div>

        {isRenaming && (
          <form
            action={(formData) => {
              renameAction(formData);
              setIsRenaming(false);
            }}
            className="mt-3 flex flex-wrap items-center gap-2"
          >
            <input type="hidden" name="agentId" value={agent.id} />
            <Input name="name" defaultValue={agent.name} required autoFocus aria-label="New name" className="w-full sm:w-64" />
            <Button type="submit" size="sm" pending={renamePending} pendingLabel="Saving...">
              Save name
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setIsRenaming(false)}>
              Cancel
            </Button>
          </form>
        )}

        {canManage && (
          <div className="mt-5 flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-4">
            {agent.status !== "disabled" && (
              <>
                <form action={rotateAction}>
                  <input type="hidden" name="agentId" value={agent.id} />
                  <Button type="submit" variant="secondary" size="sm">
                    New setup code
                  </Button>
                </form>
                <form action={restartAction}>
                  <input type="hidden" name="agentId" value={agent.id} />
                  <Button type="submit" variant="secondary" size="sm" pending={restartPending} pendingLabel="Sending...">
                    Restart it
                  </Button>
                </form>
                <form action={clearAction}>
                  <input type="hidden" name="agentId" value={agent.id} />
                  <Button type="submit" variant="secondary" size="sm" pending={clearPending} pendingLabel="Sending...">
                    Clear temp files
                  </Button>
                </form>
                <form action={disableAction}>
                  <input type="hidden" name="agentId" value={agent.id} />
                  <Button type="submit" variant="outline-danger" size="sm">
                    Turn off
                  </Button>
                </form>
              </>
            )}
            {/* Delete stays available once a server is turned off, and is never shown for an active one. */}
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
        )}
        <div className="mt-3">
          <FormError message={error} />
        </div>
      </Collapsible>
    </li>
  );
}
