import { Button, Spinner } from "@/components/ui";
import { waitingText, WAIT_GAVE_UP_TEXT } from "@/lib/library/wait-poller";
import type { WaitView } from "@/lib/library/wait-flow";

/**
 * The waiting state of a library screen (docs/PHASE-C-PLAN.md, C1d).
 *  - waiting: "Waiting for your print server to fetch this page (about N seconds)", no button (the screen is asking by itself);
 *  - after the cap: "This is taking longer than usual. Try again in a minute." with the Try again button;
 *  - print server offline: the message and the button only (it is never asked again by itself).
 */
export function WaitNotice({ view, onTryAgain, className = "" }: { view: WaitView; onTryAgain: () => void; className?: string }) {
  const polling = view.kind === "pending" && !view.gaveUp;
  const text = view.kind === "offline" ? view.message : view.gaveUp ? WAIT_GAVE_UP_TEXT : waitingText(view.elapsedMs);
  return (
    <div role="status" className={`flex flex-wrap items-center gap-3 text-sm text-[var(--color-muted)] ${className}`}>
      {polling && <Spinner />}
      <span>{text}</span>
      {!polling && (
        <Button type="button" variant="secondary" onClick={onTryAgain}>
          Try again
        </Button>
      )}
    </div>
  );
}
