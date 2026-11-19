import type { HTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** Surface container. `Card` keeps its original API (children + className); the
 *  CardHeader / CardBody / CardFooter pieces are optional structure inside it. */
export function Card({
  children,
  className = "",
  ...rest
}: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  // A caller that sets its own padding (p-0, sm:p-6 ...) replaces the matching default instead of fighting it in CSS order.
  const ownBase = /(^|\s)!?p-\d/.test(className);
  const basePad = ownBase ? "" : "p-4";
  const smPad = ownBase || /(^|\s)sm:!?p-\d/.test(className) ? "" : "sm:p-6";
  return (
    <div
      className={`rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] ${basePad} shadow-[var(--shadow-card)] ${smPad} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Title row with optional icon, one-line description and a right-hand action. */
export function CardHeader({
  title,
  description,
  icon: Icon,
  action,
  as: Heading = "h2",
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  as?: "h2" | "h3";
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        {Icon && (
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-primary-soft)] text-[var(--color-primary)] ring-1 ring-inset ring-[var(--color-primary)]/10">
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0">
          <Heading className="text-[15px] font-semibold leading-6 tracking-[-0.01em]">{title}</Heading>
          {description && <p className="mt-0.5 text-[13px] leading-5 text-[var(--color-muted)]">{description}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

export function CardBody({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-col gap-4 ${className}`}>{children}</div>;
}

/** Bottom strip for actions or fine print, separated by a hairline. */
export function CardFooter({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--color-border)] pt-4 ${className}`}>
      {children}
    </div>
  );
}
