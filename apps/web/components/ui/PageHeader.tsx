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
    <div className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3 sm:mb-8">
      <div className="min-w-0">
        <div className="flex items-center">
          <h1 className="text-[1.625rem] font-semibold leading-8 tracking-[-0.025em] sm:text-[1.75rem] sm:leading-9">{title}</h1>
          <span className="">{help === undefined ? <HelpPopover /> : help}</span>
        </div>
        {description && <p className="mt-1.5 max-w-xl text-sm leading-6 text-[var(--color-muted)] sm:text-[15px]">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-2 sm:pt-0.5">{action}</div>}
    </div>
  );
}
