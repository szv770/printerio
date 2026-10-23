/**
 * Pure state logic for the "Update this server" banner: turns the newest CHECK_FOR_UPDATE rows (plus when the
 * print server last checked in) into one plain-language view. No server-only imports, so the client banner, the
 * server page and the tests all share it.
 *
 * How progress travels without a new table: the Agent writes its current step into the command row's `result`
 * json while it runs (`{ step: "installing", message }`), the page re-reads the row every ~2 seconds, and the
 * final answer replaces it. The restart makes the Agent go quiet for a minute, which is expected: after the
 * final "updated" answer the view stays on "Restarting" until the Agent's next check-in is newer than that
 * answer, and only then says "Updated to <version>".
 */

import { CHECK_ONLY_MIN_AGENT_VERSION, LATEST_AGENT_VERSION, compareAgentVersions } from "@printio/shared";

export const UPDATE_STEPS = ["checking", "downloading", "installing", "restarting", "done"] as const;
export type UpdateStepId = (typeof UPDATE_STEPS)[number];
export type StepState = "pending" | "active" | "done" | "failed";

export const UPDATE_STEP_LABELS: Record<UpdateStepId, string> = {
  checking: "Checking",
  downloading: "Downloading",
  installing: "Installing",
  restarting: "Restarting",
  done: "Done",
};

export interface StepView {
  id: UpdateStepId;
  label: string;
  state: StepState;
}

export interface UpdateCommandRow {
  id: string;
  command: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  result: unknown;
  /** True when the request carried the fixed payload { mode: "check_only" }. */
  checkOnly: boolean;
}

export type UpdateView =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; latest: string | null; latestMessage: string | null; behind: number | null }
  | { kind: "up_to_date"; checkedAt: string | null }
  /** The running build is older than the newest version (judged by its reported version). Update now runs the full update. */
  | { kind: "outdated"; running: string | null; latest: string }
  /** The newest code is already on the machine but the running build is old: only a restart is needed. */
  | { kind: "restart_needed"; running: string | null; latest: string }
  | { kind: "check_failed"; message: string }
  | { kind: "updating"; steps: StepView[]; message: string | null; /** When Update now was pressed (ISO), for the elapsed clock. */ startedAt: string | null }
  | { kind: "restarting"; steps: StepView[]; to: string | null }
  | { kind: "done"; steps: StepView[]; from: string | null; to: string | null }
  | { kind: "failed"; steps: StepView[]; message: string };

/** A check nobody answered for this long is shown as "could not check" instead of spinning. */
export const CHECK_GIVE_UP_MS = 3 * 60_000;
/** A full update nobody picked up for this long: the server is probably off. */
export const UPDATE_PICKUP_GIVE_UP_MS = 5 * 60_000;
/** A full update still running after this long is treated as stuck (the install itself times out at 10 minutes). */
export const UPDATE_RUN_GIVE_UP_MS = 15 * 60_000;
/** After the agent says "updated", how long it may stay quiet before we call it a failure. */
export const RESTART_GIVE_UP_MS = 6 * 60_000;
/** A result younger than this is reused instead of checking again when the page opens. */
export const AUTO_CHECK_FRESH_MS = 10 * 60_000;
/** The agent must have checked in this recently to be worth asking. */
export const AUTO_CHECK_ONLINE_MS = 2 * 60_000;
/** Keep the "Updated to ..." message for at least this long before an automatic re-check replaces it. */
export const DONE_KEEP_MS = 10 * 60_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

function stepOf(result: unknown): UpdateStepId | null {
  if (!isRecord(result)) return null;
  const s = result.step;
  return typeof s === "string" && (UPDATE_STEPS as readonly string[]).includes(s) ? (s as UpdateStepId) : null;
}

function buildSteps(active: UpdateStepId, mode: "active" | "failed" | "all_done" = "active"): StepView[] {
  const activeIdx = UPDATE_STEPS.indexOf(active);
  return UPDATE_STEPS.map((id, i) => {
    let state: StepState;
    if (mode === "all_done") state = "done";
    else if (i < activeIdx) state = "done";
    else if (i === activeIdx) state = mode === "failed" ? "failed" : "active";
    else state = "pending";
    return { id, label: UPDATE_STEP_LABELS[id], state };
  });
}

function failed(message: string, at: UpdateStepId): UpdateView {
  return { kind: "failed", message, steps: buildSteps(at, "failed") };
}

function deriveFromCheck(row: UpdateCommandRow, nowMs: number): UpdateView {
  const created = ms(row.createdAt);
  if (row.status === "pending" || row.status === "acknowledged") {
    if (Number.isFinite(created) && nowMs - created > CHECK_GIVE_UP_MS) {
      return { kind: "check_failed", message: "The print server did not answer in time. It may be switched off or offline." };
    }
    return { kind: "checking" };
  }
  if (row.status === "failed") return { kind: "check_failed", message: "The print server could not check for updates right now." };
  const r = isRecord(row.result) ? row.result : {};
  if (r.updateAvailable === true) {
    return {
      kind: "available",
      latest: str(r.latest, 40),
      latestMessage: str(r.latestMessage, 140),
      behind: typeof r.behind === "number" && Number.isFinite(r.behind) ? r.behind : null,
    };
  }
  if (r.updateAvailable === false && !r.reason) return { kind: "up_to_date", checkedAt: row.completedAt ?? row.createdAt };
  if (r.reason === "up_to_date") return { kind: "up_to_date", checkedAt: row.completedAt ?? row.createdAt };
  return { kind: "check_failed", message: str(r.message, 400) ?? "The print server could not check for updates right now." };
}

function deriveFromUpdate(row: UpdateCommandRow, lastSeenAt: string | null, nowMs: number): UpdateView {
  const created = ms(row.createdAt);
  const age = Number.isFinite(created) ? nowMs - created : 0;
  const r = isRecord(row.result) ? row.result : {};
  const step = stepOf(row.result);

  if (row.status === "pending") {
    if (age > UPDATE_PICKUP_GIVE_UP_MS) {
      return failed("The print server did not pick this up. It may be switched off or offline. Switch it on and try again.", "checking");
    }
    return { kind: "updating", steps: buildSteps("checking"), message: "Waiting for the print server to pick this up...", startedAt: row.createdAt };
  }
  if (row.status === "acknowledged") {
    if (age > UPDATE_RUN_GIVE_UP_MS) {
      return failed("The update is taking much longer than expected, so it is probably stuck. Try again, or check the print server computer.", step ?? "checking");
    }
    return { kind: "updating", steps: buildSteps(step && step !== "done" ? step : "checking"), message: str(r.message, 200), startedAt: row.createdAt };
  }
  if (row.status === "failed") {
    return failed(str(r.message, 400) ?? "The update did not complete. Try again.", step ?? "checking");
  }

  // completed
  if (r.updated === true) {
    const to = str(r.to, 40);
    const from = str(r.from, 40);
    const completed = ms(row.completedAt);
    const seen = ms(lastSeenAt);
    if (Number.isFinite(completed) && Number.isFinite(seen) && seen > completed) {
      return { kind: "done", steps: buildSteps("done", "all_done"), from, to };
    }
    if (Number.isFinite(completed) && nowMs - completed > RESTART_GIVE_UP_MS) {
      return failed("The update was installed, but the print server did not come back within a few minutes. Check that its computer is on, then press Try again.", "restarting");
    }
    return { kind: "restarting", steps: buildSteps("restarting"), to };
  }
  if (r.reason === "already_up_to_date") return { kind: "up_to_date", checkedAt: row.completedAt ?? row.createdAt };
  return failed(str(r.message, 400) ?? "The update did not complete. Try again.", step ?? "checking");
}

/** "m:ss" for the elapsed clock on the update banner. */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Extra reassurance while the slow Installing step is the active one (null on every other step). */
export function installingHint(steps: StepView[]): string | null {
  return steps.some((s) => s.id === "installing" && s.state === "active") ? "Installing - this can take about a minute" : null;
}

/** A restart request this recent is part of the update story; an older one is just history. */
export const RESTART_ROW_KEEP_MS = 10 * 60_000;

export interface DeriveInput {
  commands: UpdateCommandRow[];
  lastSeenAt: string | null;
  nowMs: number;
  /**
   * The version the print server reports it is RUNNING. `undefined` = not provided (version logic off); `null` = it
   * never reported one. An "already up to date" answer only proves the checkout on disk is current, never the
   * running build, so the version decides what "up to date" means.
   */
  agentVersion?: string | null;
  latestVersion?: string;
}

function isOutdated(version: string | null | undefined, latest: string): boolean {
  const state = compareAgentVersions(version, latest);
  return state === "outdated" || state === "unknown";
}

function deriveFromRestart(row: UpdateCommandRow, lastSeenAt: string | null, nowMs: number, version: string | null, latest: string): UpdateView {
  const created = ms(row.createdAt);
  const age = Number.isFinite(created) ? nowMs - created : 0;
  if (row.status === "pending") {
    if (age > UPDATE_PICKUP_GIVE_UP_MS) return failed("The print server did not pick up the restart. It may be switched off or offline.", "restarting");
    return { kind: "restarting", steps: buildSteps("restarting"), to: null };
  }
  if (row.status === "failed") return failed("The restart did not go through. Try again.", "restarting");
  const completed = ms(row.completedAt);
  const seen = ms(lastSeenAt);
  if (Number.isFinite(completed) && Number.isFinite(seen) && seen > completed) {
    if (isOutdated(version, latest)) {
      return failed(`The print server restarted but is still running ${version ?? "an unknown version"}, not ${latest}. Press Update now to try again.`, "restarting");
    }
    return { kind: "done", steps: buildSteps("done", "all_done"), from: null, to: version };
  }
  if (Number.isFinite(completed) && nowMs - completed > RESTART_GIVE_UP_MS) {
    return failed("The print server did not come back within a few minutes. Check that its computer is on.", "restarting");
  }
  return { kind: "restarting", steps: buildSteps("restarting"), to: null };
}

export function deriveUpdateView(input: DeriveInput): UpdateView {
  const latestVersion = input.latestVersion ?? LATEST_AGENT_VERSION;
  const versionAware = input.agentVersion !== undefined;
  const version = input.agentVersion ?? null;
  const capable = !versionAware || agentSupportsCheckOnly(version);

  // Newest first, like the page query. A recent restart request newer than the newest update request is the story.
  const update = input.commands.find((c) => c.command === "CHECK_FOR_UPDATE");
  const restart = input.commands.find((c) => c.command === "RESTART_AGENT_SERVICE");
  if (restart && versionAware) {
    const rc = ms(restart.createdAt);
    const uc = update ? ms(update.createdAt) : -Infinity;
    if (Number.isFinite(rc) && input.nowMs - rc < RESTART_ROW_KEEP_MS && rc >= uc) {
      return deriveFromRestart(restart, input.lastSeenAt, input.nowMs, version, latestVersion);
    }
  }

  let view: UpdateView;
  if (!update) {
    view = !versionAware || capable ? { kind: "idle" } : isOutdated(version, latestVersion) ? { kind: "outdated", running: version, latest: latestVersion } : { kind: "up_to_date", checkedAt: null };
  } else {
    // An agent that cannot do check_only ran any such request as a FULL update, so read its row as one.
    const asCheck = update.checkOnly && capable;
    view = asCheck ? deriveFromCheck(update, input.nowMs) : deriveFromUpdate(update, input.lastSeenAt, input.nowMs);
  }

  if (versionAware && view.kind === "up_to_date" && isOutdated(version, latestVersion)) {
    return { kind: "restart_needed", running: version, latest: latestVersion };
  }
  return view;
}

/** Should opening the page quietly ask the server whether an update exists? */
export function shouldAutoCheck(input: DeriveInput & { agentVersion: string | null | undefined }): boolean {
  if (!agentSupportsCheckOnly(input.agentVersion)) return false;
  const seen = ms(input.lastSeenAt);
  if (!Number.isFinite(seen) || input.nowMs - seen > AUTO_CHECK_ONLINE_MS) return false;
  const view = deriveUpdateView(input);
  if (view.kind === "idle") return true;
  if (view.kind === "checking" || view.kind === "updating" || view.kind === "restarting") return false;
  const latest = input.commands.find((c) => c.command === "CHECK_FOR_UPDATE");
  if (!latest) return true;
  const when = ms(latest.completedAt ?? latest.createdAt);
  const age = Number.isFinite(when) ? input.nowMs - when : Infinity;
  const keep = view.kind === "done" || view.kind === "failed" ? DONE_KEEP_MS : AUTO_CHECK_FRESH_MS;
  return age > keep;
}

/** True while the page should poll quickly (every ~2s). */
export function isUpdateLive(view: UpdateView): boolean {
  return view.kind === "checking" || view.kind === "updating" || view.kind === "restarting";
}

/**
 * Whether the Agent has reported a version that understands check_only. An older Agent would read the same
 * payload as "update now", so nothing may be sent to it automatically (or at all) until it reports this.
 */
export function agentSupportsCheckOnly(version: string | null | undefined): boolean {
  const state = compareAgentVersions(version, CHECK_ONLY_MIN_AGENT_VERSION);
  return state === "up_to_date" || state === "ahead";
}
