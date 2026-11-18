import { CircleCheck } from "lucide-react";
import { confirmedBannerText } from "@/lib/devices/confirmed";

/** A slim banner on the device pages: what has been proven on real devices, and what is still being tested. */
export function ConfirmedBanner() {
  const { headline, detail } = confirmedBannerText();
  return (
    <div role="status" className="mb-4 flex items-start gap-3 rounded-2xl bg-[var(--color-success-soft)] p-3.5 text-sm">
      <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-success)]" aria-hidden="true" />
      <p className="min-w-0 leading-6">
        <span className="font-semibold">{headline}</span>
        {detail && <span className="text-[var(--color-muted)]"> {detail}</span>}
      </p>
    </div>
  );
}
