"use client";

import { startTransition, useActionState, useEffect, useRef } from "react";
import type { Tables } from "@/lib/database.types";
import { agentSupportsCheckOnly, deriveUpdateView, shouldAutoCheck, type UpdateCommandRow } from "@/lib/update-progress";
import { agentRunningCommitLabel } from "@/lib/admin/summaries";
import { Button } from "@/components/ui";
import { LocalTime } from "@/components/LocalTime";
import { cancelPendingUpdateAction, checkAgentForUpdateAction, checkAgentUpdateAvailableAction, restartAgentServiceAction, type AgentActionState } from "../actions";
import { UpdateBanner } from "./UpdateBanner";
import { UpdateToast } from "./UpdateToast";

const initial: AgentActionState = {};

/**
 * The live update banner for one print server. Opening the page quietly asks the server whether an update exists
 * (fetch + compare only); pressing Update starts the real update and the server page re-reads the command row
 * every ~2 seconds, so each step shows as it happens (see lib/update-progress.ts).
 */
export function UpdatePanel({
  agent,
  commands,
  nowMs,
}: {
  agent: Tables<"agents">;
  commands: UpdateCommandRow[];
  nowMs: number;
}) {
  const [checkState, checkAction, checking] = useActionState(checkAgentUpdateAvailableAction, initial);
  const [updateState, updateAction, updating] = useActionState(checkAgentForUpdateAction, initial);
  const [restartState, restartAction, restarting] = useActionState(restartAgentServiceAction, initial);
  const [cancelState, cancelAction, cancelling] = useActionState(cancelPendingUpdateAction, initial);
  const asked = useRef(false);

  // Absent before migration 0059 is applied, null for an older server: both mean "not reported" and change nothing.
  const runningCommit = agent.running_commit ?? null;
  const view = deriveUpdateView({ commands, lastSeenAt: agent.last_seen_at, nowMs, agentVersion: agent.version, runningCommit });
  const canSelfUpdate = agent.is_git_checkout === true;
  const online = agent.last_seen_at ? nowMs - Date.parse(agent.last_seen_at) < 5 * 60_000 : false;
  const autoCheck = canSelfUpdate && shouldAutoCheck({ commands, lastSeenAt: agent.last_seen_at, nowMs, agentVersion: agent.version });

  const form = (): FormData => {
    const f = new FormData();
    f.set("agentId", agent.id);
    return f;
  };

  // Ask once when the page opens (and the server is reachable). Later re-reads never ask again by themselves.
  useEffect(() => {
    if (!autoCheck || asked.current) return;
    asked.current = true;
    startTransition(() => checkAction(form()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCheck]);

  const capable = agentSupportsCheckOnly(agent.version);
  // "legacy" (no look-only check possible) now only decides which wording the banner uses when it has nothing else.
  const situation = agent.is_git_checkout === false ? "cannot_update" : !capable ? "normal" : !online ? "offline" : "normal";
  // Until the server data catches up with a button press, show the first step instead of a stale state.
  const shown = updating ? deriveUpdateView({ commands: [{ id: "local", command: "CHECK_FOR_UPDATE", status: "pending", createdAt: new Date(nowMs).toISOString(), completedAt: null, result: null, checkOnly: false }], lastSeenAt: null, nowMs }) : view;

  const commitLine = runningCommit ? <p className="mt-1.5 px-1 text-[13px] text-[var(--color-muted)]">This print server is {agentRunningCommitLabel(runningCommit)}.</p> : null;

  // An update that could not start because the server is offline: it stays queued, and can be cancelled while it is still pending.
  if (shown.kind === "queued") {
    const pendingUpdate = commands.find((c) => c.command === "CHECK_FOR_UPDATE" && !c.checkOnly && c.status === "pending");
    return (
      <>
        <div role="status" aria-live="polite" className="rounded-[var(--radius-card)] border border-[var(--color-warning)]/25 bg-[var(--color-warning-soft)] p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold leading-snug text-[var(--color-text)]">Update queued</p>
              <p className="mt-0.5 text-sm text-[var(--color-text-2)]">{shown.message}</p>
              <p className="mt-1 text-[13px] text-[var(--color-muted)]">
                {shown.startedAt ? (
                  <>
                    Asked <LocalTime value={shown.startedAt} />.{" "}
                  </>
                ) : null}
                It will restart the print server when it starts, so cancel it if the server comes back during printing hours.
              </p>
              {cancelState.error ? <p className="mt-2 text-sm text-[var(--color-danger-ink)]">{cancelState.error}</p> : null}
            </div>
            {pendingUpdate ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const f = form();
                  f.set("commandId", pendingUpdate.id);
                  startTransition(() => cancelAction(f));
                }}
                pending={cancelling}
                pendingLabel="Cancelling..."
              >
                Cancel update
              </Button>
            ) : null}
          </div>
        </div>
        {commitLine}
      </>
    );
  }

  return (
    <>
    <UpdateToast view={shown} />
    <UpdateBanner
      view={shown}
      situation={situation}
      busy={updating || checking || restarting}
      error={updateState.error ?? checkState.error ?? restartState.error ?? null}
      canCheckAgain={capable}
      onUpdate={() => startTransition(() => updateAction(form()))}
      onRestart={() => startTransition(() => restartAction(form()))}
      onCheckAgain={() => startTransition(() => checkAction(form()))}
    />
    {commitLine}
    </>
  );
}
