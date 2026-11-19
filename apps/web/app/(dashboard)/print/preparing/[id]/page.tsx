import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { loadPrepareView } from "@/lib/prepare/status";
import { routes } from "@/lib/routes";
import { buttonClass, Card } from "@/components/ui";
import { AutoRefresh, CancelPreparing, ConfirmBooklet } from "./PreparingLive";

export const dynamic = "force-dynamic";

/** "Preparing your file..." - shown between submitting and the job existing, when the print server prepares the PDF (docs/PREPARE-JOBS-DESIGN.md). */
export default async function PreparingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSessionOrRedirect();
  const view = await loadPrepareView(createServiceRoleClient(), session.userId, id);
  if (!view) notFound();
  if (view.state === "done") redirect(routes.job(view.printJobId));

  return (
    <div className="mx-auto max-w-xl py-8">
      <AutoRefresh active={view.state === "preparing"} />
      <Card className="p-6">
        <h1 className="text-xl font-semibold">{headline(view.state)}</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">{view.fileName}</p>

        {view.state === "preparing" ? (
          <>
            <p className="mt-4" role="status">
              {view.serverOnline
                ? "Getting your file ready. This usually takes a few seconds, and you can leave this page: it will show up in My jobs."
                : "Your print server is offline, so I can't prepare this right now. It will continue by itself when the server is back (it waits up to 24 hours)."}
            </p>
            <CancelPreparing jobId={id} />
          </>
        ) : null}

        {view.state === "needs_booklet_confirm" ? (
          <>
            <p className="mt-4">
              This file has {view.needsBookletConfirm.sourcePages} pages. A booklet needs a multiple of 4, so {view.needsBookletConfirm.blankPagesAdded} blank{" "}
              {view.needsBookletConfirm.blankPagesAdded === 1 ? "page" : "pages"} would be added at the end ({view.needsBookletConfirm.paddedPages} in total).
            </p>
            <ConfirmBooklet jobId={id} blankPages={view.needsBookletConfirm.blankPagesAdded} />
            <p className="mt-3"><Link className="text-sm underline" href={routes.print}>No, go back</Link></p>
          </>
        ) : null}

        {view.state === "failed" ? (
          <>
            <p className="mt-4" role="alert">{view.fieldError ?? view.message}</p>
            <Link className={`${buttonClass("primary")} mt-4 inline-flex`} href={routes.print}>Back to the print page</Link>
          </>
        ) : null}

        {view.state === "cancelled" ? (
          <>
            <p className="mt-4">Cancelled. Nothing was printed.</p>
            <Link className={`${buttonClass("primary")} mt-4 inline-flex`} href={routes.print}>Back to the print page</Link>
          </>
        ) : null}
      </Card>
    </div>
  );
}

function headline(state: string): string {
  switch (state) {
    case "preparing": return "Preparing your file...";
    case "needs_booklet_confirm": return "One question about your booklet";
    case "failed": return "We couldn't prepare this file";
    default: return "Cancelled";
  }
}
