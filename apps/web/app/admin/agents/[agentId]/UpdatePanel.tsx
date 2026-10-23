"use client";

import { startTransition, useActionState, useEffect, useRef } from "react";
import type { Tables } from "@/lib/database.types";
import { agentSupportsCheckOnly, deriveUpdateView, shouldAutoCheck, type UpdateCommandRow } from "@/lib/update-progress";
import { checkAgentForUpdateAction, checkAgentUpdateAvailableAction, restartAgentServiceAction, type AgentActionState } from "../actions";
import { UpdateBanner } from "./UpdateBanner";

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
  const asked = useRef(false);

  const view = deriveUpdateView({ commands, lastSeenAt: agent.last_seen_at, nowMs, agentVersion: agent.version });
  const canSelfUpdate = agent.is_git_checkout === true;
  const online = agent.last_seen_at ? nowMs - Date.parse(agent.last_seen_at) < 2 * 60_000 : false;
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

  return (
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
  );
}
