import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Every "nothing here yet" state in the app renders through this one
 * component. `message` (the original API) is the single line; `title` and
 * `description` give a heading plus a sentence when the moment deserves it.
 * `icon` and `action` differentiate first-run, all-clear and setup-gap states.
 */
export function EmptyState({
  message,
  title,
  description,
  icon: Icon,
  action,
}: {
  message?: string;
  title?: string;
  description?: string;
  icon?: LucideIcon;
  action?: ReactNode;
}) {
  const body = description ?? message;
  return (
    <div className="flex flex-col items-center gap-4 rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)]/70 px-6 py-12 text-center">
      {Icon && (
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary)] ring-8 ring-[var(--color-primary-soft)]/50">
          <Icon className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
        </span>
      )}
      <div className="max-w-sm">
        {title && <p className="text-[15px] font-semibold leading-6 tracking-[-0.01em]">{title}</p>}
        {body && <p className={`text-sm leading-6 text-[var(--color-muted)] ${title ? "mt-1" : ""}`}>{body}</p>}
      </div>
      {action}
    </div>
  );
}
