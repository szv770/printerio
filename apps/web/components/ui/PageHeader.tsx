import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3 sm:mb-8">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold leading-8 sm:text-[1.75rem] sm:leading-9">{title}</h1>
        {description && <p className="mt-1.5 max-w-xl text-[15px] leading-6 text-[var(--color-muted)]">{description}</p>}
      </div>
      {action}
    </div>
  );
}
