import Link from "next/link";
import { Printer } from "lucide-react";
import { routes } from "@/lib/routes";

/** The one big action on both home screens. */
export function BigPrintCard({ hint, tourId }: { hint: string; tourId?: string }) {
  return (
    <Link
      href={routes.print}
      data-tour={tourId}
      className="flex items-center gap-4 rounded-[var(--radius-card)] bg-[var(--color-primary)] p-5 text-[var(--color-primary-fg)] shadow-[inset_0_1px_0_rgb(255_255_255/0.2),var(--shadow-card)] transition-colors hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:shadow-[var(--ring)] sm:p-6"
    >
      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/15">
        <Printer className="h-7 w-7" aria-hidden="true" />
      </span>
      <span>
        <span className="block text-xl font-bold tracking-[-0.02em]">Print a document</span>
        <span className="mt-0.5 block text-sm opacity-90">{hint}</span>
      </span>
    </Link>
  );
}
