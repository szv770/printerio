import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Every "nothing here yet" state in the app renders through this one
 * component - previously just a message string in a dashed box, regardless
 * of whether the situation was a first-run onboarding moment (no print jobs
 * yet), a genuinely good state (no approvals pending = you're caught up), or
 * an admin setup gap (no printers configured). `icon` and `action` let a
 * caller differentiate that tone without every usage reinventing its own
 * empty-state layout.
 */
export function EmptyState({
  message,
  icon: Icon,
  action,
}: {
  message: string;
  icon?: LucideIcon;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center">
      {Icon && <Icon className="h-8 w-8 text-[var(--color-muted)]" />}
      <p className="text-sm text-[var(--color-muted)]">{message}</p>
      {action}
    </div>
  );
}
