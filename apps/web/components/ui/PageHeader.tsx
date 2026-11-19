import type { ReactNode } from "react";
import { HelpPopover } from "@/components/help/HelpPopover";

export function PageHeader({
  title,
  description,
  action,
  help,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  /** The "?" next to the title. Shown automatically for pages that have help; pass `false` to hide it. */
  help?: ReactNode | false;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3 sm:mb-8">
      <div className="min-w-0">
        <div className="flex items-start">
          <h1 className="text-2xl font-semibold leading-8 sm:text-[1.75rem] sm:leading-9">{title}</h1>
          <span className="mt-0.5 sm:mt-1">{help === undefined ? <HelpPopover /> : help}</span>
        </div>
        {description && <p className="mt-1.5 max-w-xl text-[15px] leading-6 text-[var(--color-muted)]">{description}</p>}
      </div>
      {action}
    </div>
  );
}
