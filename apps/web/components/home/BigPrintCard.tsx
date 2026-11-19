import Link from "next/link";
import { Printer } from "lucide-react";
import { routes } from "@/lib/routes";

/** The one big action on both home screens. */
export function BigPrintCard({ hint, tourId }: { hint: string; tourId?: string }) {
  return (
    <Link
      href={routes.print}
      data-tour={tourId}
      className="flex items-center gap-4 rounded-[var(--radius-card)] bg-[linear-gradient(135deg,#0d6fe8,#0a58bd)] p-5 text-[var(--color-primary-fg)] shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_1px_2px_rgb(10_100_216/0.3),0_12px_28px_-12px_rgb(10_100_216/0.55)] transition-[filter,box-shadow] hover:brightness-95 focus-visible:outline-none focus-visible:shadow-[var(--ring)] sm:p-6"
    >
      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[var(--radius-card)] bg-white/15 ring-1 ring-inset ring-white/20">
        <Printer className="h-7 w-7" aria-hidden="true" />
      </span>
      <span>
        <span className="block text-xl font-semibold tracking-[-0.02em]">Print a document</span>
        <span className="mt-0.5 block text-sm opacity-90">{hint}</span>
      </span>
    </Link>
  );
}
