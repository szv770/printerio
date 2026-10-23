import type { ReactNode } from "react";
import { Check, CircleArrowUp, CircleCheck, RefreshCw, TriangleAlert, X } from "lucide-react";
import { Button, Spinner } from "@/components/ui";
import { LocalTime } from "@/components/LocalTime";
import { installingHint, type StepView, type UpdateView } from "@/lib/update-progress";
import { ElapsedClock } from "./ElapsedClock";

type Tone = "primary" | "success" | "warning" | "danger" | "neutral";

const TONE: Record<Tone, { box: string; icon: string }> = {
  primary: { box: "border-[var(--color-primary)]/25 bg-[var(--color-primary-soft)]", icon: "bg-[var(--color-primary)] text-[var(--color-primary-fg)]" },
  success: { box: "border-[var(--color-success)]/25 bg-[var(--color-success-soft)]", icon: "bg-[var(--color-success)] text-white" },
  warning: { box: "border-[var(--color-warning)]/25 bg-[var(--color-warning-soft)]", icon: "bg-[var(--color-warning)] text-white" },
  danger: { box: "border-[var(--color-danger)]/25 bg-[var(--color-danger-soft)]", icon: "bg-[var(--color-danger)] text-white" },
  neutral: { box: "border-[var(--color-border)] bg-[var(--color-surface)]", icon: "bg-[var(--color-surface-2)] text-[var(--color-muted)]" },
};

/** Where the banner can be shown when the page is not in a normal state. */
export type BannerSituation = "normal" | "offline" | "cannot_update" | "legacy";

export interface UpdateBannerProps {
  view: UpdateView;
  situation?: BannerSituation;
  /** The update/Try again button is working (the request is being sent). */
  busy?: boolean;
  error?: string | null;
  onUpdate?: () => void;
  /** Restart-only action, for the case where the newest code is already on the machine. */
  onRestart?: () => void;
  onCheckAgain?: () => void;
  /** Whether the print server can do a look-only check. Without it "Check again" is not offered at all. */
  canCheckAgain?: boolean;
  /** Fixed "now" (ms) for the elapsed clock; only the dev preview sets it so screenshots are steady. */
  elapsedNow?: number;
}

function StepIcon({ state }: { state: StepView["state"] }) {
  if (state === "done") {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-success)] text-white">
        <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }
  if (state === "active") {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface)] text-[var(--color-primary)] ring-2 ring-[var(--color-primary)]">
        <Spinner className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-danger)] text-white">
        <X className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }
  return <span className="h-6 w-6 shrink-0 rounded-full border-2 border-[var(--color-border-strong)] bg-[var(--color-surface)]" aria-hidden="true" />;
}

const STATE_WORD: Record<StepView["state"], string> = { done: "finished", active: "in progress", failed: "failed", pending: "waiting" };

/** The five live steps: a row on wide screens, a list on phones. */
export function UpdateSteps({ steps }: { steps: StepView[] }) {
  return (
    <ol className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:gap-0" aria-label="Update progress">
      {steps.map((step) => (
        <li
          key={step.id}
          aria-current={step.state === "active" ? "step" : undefined}
          className="flex items-center gap-2.5 sm:flex-1 sm:flex-col sm:items-start sm:gap-2"
        >
          <span
            aria-hidden="true"
            className={`hidden h-1 w-full rounded-full sm:block ${
              step.state === "done"
                ? "bg-[var(--color-success)]"
                : step.state === "active"
                  ? "bg-[var(--color-primary)] opacity-70"
                  : step.state === "failed"
                    ? "bg-[var(--color-danger)]"
                    : "bg-[var(--color-border-strong)]/60"
            }`}
          />
          <span className="flex items-center gap-2.5 sm:pr-2">
            <StepIcon state={step.state} />
            <span
              className={`text-sm ${step.state === "pending" ? "text-[var(--color-muted)]" : "font-medium text-[var(--color-text)]"}`}
            >
              {step.label}
              <span className="sr-only"> - {STATE_WORD[step.state]}</span>
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Shell({
  tone,
  icon,
  title,
  children,
  action,
}: {
  tone: Tone;
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div role="status" aria-live="polite" className={`rounded-[var(--radius-card)] border p-4 sm:p-5 ${TONE[tone].box}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${TONE[tone].icon}`}>{icon}</span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold leading-snug text-[var(--color-text)]">{title}</p>
            {children}
          </div>
        </div>
        {action ? <div className="flex shrink-0 flex-col gap-2 sm:items-end">{action}</div> : null}
      </div>
    </div>
  );
}

const sub = "mt-0.5 text-sm text-[var(--color-text-2)] [overflow-wrap:anywhere]";

/**
 * The calm update banner on the print server page. Purely presentational: it renders exactly the state it is
 * given (see lib/update-progress.ts), so every state can be shown in the dev preview without a server.
 */
export function UpdateBanner({ view, situation = "normal", busy = false, error, onUpdate, onRestart, onCheckAgain, canCheckAgain = false, elapsedNow }: UpdateBannerProps) {
  if (situation === "cannot_update") {
    return (
      <Shell tone="neutral" icon={<CircleArrowUp className="h-5 w-5" aria-hidden="true" />} title="This print server cannot update itself">
        <p className={sub}>
          To update it, run <code className="rounded bg-[var(--color-surface-2)] px-1 py-0.5 font-mono text-xs">setup-agent.bat</code> on that
          computer.
        </p>
      </Shell>
    );
  }

  // An older agent cannot do a look-only check (it would do the full update), so there is nothing to show but the
  // plain button and a note. Live progress states still show normally.
  if (situation === "legacy" && (view.kind === "idle" || view.kind === "check_failed" || view.kind === "checking")) {
    return (
      <Shell
        tone="neutral"
        icon={<CircleArrowUp className="h-5 w-5" aria-hidden="true" />}
        title="Update this print server"
        action={
          <Button type="button" variant="primary" onClick={onUpdate} pending={busy} pendingLabel="Starting...">
            Update now
          </Button>
        }
      >
        <p className={sub}>Printio will check for updates by itself after your next update.</p>
        <p className="mt-1 text-[13px] text-[var(--color-muted)]">Pressing Update now installs the newest version. The print server restarts and is unavailable for about a minute.</p>
        {error ? <p className="mt-2 text-sm text-[var(--color-danger-ink)]">{error}</p> : null}
      </Shell>
    );
  }

  if (situation === "offline" && (view.kind === "idle" || view.kind === "check_failed" || view.kind === "up_to_date")) {
    return (
      <Shell tone="neutral" icon={<CircleArrowUp className="h-5 w-5" aria-hidden="true" />} title="Cannot check for updates right now">
        <p className={sub}>The print server is offline or switched off. Printio will check as soon as you open this page while it is back on.</p>
      </Shell>
    );
  }

  switch (view.kind) {
    case "idle":
    case "checking":
      return (
        <Shell tone="neutral" icon={<Spinner className="h-5 w-5" />} title="Checking for updates...">
          <p className={sub}>This only looks. Nothing is changed on the print server.</p>
        </Shell>
      );

    case "up_to_date":
      return (
        <Shell
          tone="success"
          icon={<CircleCheck className="h-5 w-5" aria-hidden="true" />}
          title="Up to date"
          action={
            canCheckAgain ? (
              <Button type="button" variant="ghost" size="sm" onClick={onCheckAgain} pending={busy} pendingLabel="Checking...">
                <span className="flex items-center gap-1.5">
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Check again
                </span>
              </Button>
            ) : undefined
          }
        >
          <p className={sub}>
            {view.checkedAt ? (
              <>
                Checked <LocalTime value={view.checkedAt} />.
              </>
            ) : (
              "Checked just now."
            )}{" "}
            This print server has the newest Printio.
          </p>
          {error ? <p className="mt-2 text-sm text-[var(--color-danger-ink)]">{error}</p> : null}
        </Shell>
      );

    case "available":
      return (
        <Shell
          tone="primary"
          icon={<CircleArrowUp className="h-5 w-5" aria-hidden="true" />}
          title="An update is available"
          action={
            <>
              <Button type="button" variant="primary" onClick={onUpdate} pending={busy} pendingLabel="Starting...">
                Update now
              </Button>
            </>
          }
        >
          <p className={sub}>
            {view.latestMessage ? <>New: &ldquo;{view.latestMessage}&rdquo;. </> : null}
            {view.latest ? <>Newest version {view.latest}. </> : null}
          </p>
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">The print server restarts and is unavailable for about a minute. Best done when nothing is printing.</p>
          {error ? <p className="mt-2 text-sm text-[var(--color-danger-ink)]">{error}</p> : null}
        </Shell>
      );

    case "check_failed":
      return (
        <Shell
          tone="warning"
          icon={<TriangleAlert className="h-5 w-5" aria-hidden="true" />}
          title="Could not check for updates"
          action={
            canCheckAgain ? (
              <Button type="button" variant="outline" size="sm" onClick={onCheckAgain} pending={busy} pendingLabel="Checking...">
                Check again
              </Button>
            ) : undefined
          }
        >
          <p className={sub}>{view.message}</p>
          {error ? <p className="mt-2 text-sm text-[var(--color-danger-ink)]">{error}</p> : null}
        </Shell>
      );

    case "outdated":
      return (
        <Shell
          tone="primary"
          icon={<CircleArrowUp className="h-5 w-5" aria-hidden="true" />}
          title="An update is available"
          action={
            <Button type="button" variant="primary" onClick={onUpdate} pending={busy} pendingLabel="Starting...">
              Update now
            </Button>
          }
        >
          <p className={sub}>
            This print server is running {view.running ?? "an unknown version"}. The newest is {view.latest}.
          </p>
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">The print server restarts and is unavailable for about a minute. Best done when nothing is printing.</p>
          {error ? <p className="mt-2 text-sm text-[var(--color-danger-ink)]">{error}</p> : null}
        </Shell>
      );

    case "restart_needed":
      return (
        <Shell
          tone="primary"
          icon={<RefreshCw className="h-5 w-5" aria-hidden="true" />}
          title="The new version is downloaded. A restart is needed."
          action={
            <Button type="button" variant="primary" onClick={onRestart} pending={busy} pendingLabel="Restarting...">
              Restart now
            </Button>
          }
        >
          <p className={sub}>
            The newest code is already on the print server, but it is still running {view.running ?? "an older version"} (newest is {view.latest}).
            Restarting the print agent loads it. The phone gateway may also need a restart; if phones still misbehave afterwards, ask whoever manages the server.
          </p>
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">The print server is unavailable for about a minute while it restarts.</p>
          {error ? <p className="mt-2 text-sm text-[var(--color-danger-ink)]">{error}</p> : null}
        </Shell>
      );

    case "updating":
      return (
        <Shell tone="primary" icon={<Spinner className="h-5 w-5" />} title="Updating the print server...">
          {installingHint(view.steps) ? (
            <p className="mt-0.5 text-sm font-medium text-[var(--color-text)]">{installingHint(view.steps)}</p>
          ) : view.message ? (
            <p className={sub}>{view.message}</p>
          ) : null}
          <UpdateSteps steps={view.steps} />
          <p className="mt-3 text-[13px] text-[var(--color-muted)]">
            <ElapsedClock since={view.startedAt} now={elapsedNow} />
            {view.startedAt ? " - " : ""}You can keep this page open. It updates by itself.
          </p>
        </Shell>
      );

    case "restarting":
      return (
        <Shell tone="primary" icon={<Spinner className="h-5 w-5" />} title="Restarting the print server...">
          <p className={sub}>It goes quiet for a minute while it restarts. That is normal. Printio will say when it is back.</p>
          <UpdateSteps steps={view.steps} />
        </Shell>
      );

    case "done":
      return (
        <Shell tone="success" icon={<CircleCheck className="h-5 w-5" aria-hidden="true" />} title={view.to ? `Updated to ${view.to}. Restarted.` : "Updated. Restarted."}>
          <p className={sub}>The print server is back and running the newest Printio.</p>
          <UpdateSteps steps={view.steps} />
        </Shell>
      );

    case "failed":
      return (
        <Shell
          tone="danger"
          icon={<TriangleAlert className="h-5 w-5" aria-hidden="true" />}
          title="The update did not finish"
          action={
            <Button type="button" variant="primary" onClick={onUpdate} pending={busy} pendingLabel="Starting...">
              Try again
            </Button>
          }
        >
          <p className={sub}>{view.message}</p>
          <UpdateSteps steps={view.steps} />
          {error ? <p className="mt-2 text-sm text-[var(--color-danger-ink)]">{error}</p> : null}
        </Shell>
      );
  }
}
