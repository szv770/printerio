import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { viewFromRow } from "./status";
import { PREPARE_KIND } from "./prepare-jobs";

/**
 * The phone print dialog (IPP gateway) on the print-server path (docs/PREPARE-JOBS-DESIGN.md, P2c). The phone is told a job id straight away, so it gets the
 * PREPARE job's id, which is also the id the print job will have: the gateway keeps using that one id through "preparing" and afterwards, and it needs no change.
 * While no print job exists these helpers answer the gateway's status and cancel calls from the prepare job instead.
 */
export interface GatewayPrepareJob {
  id: string;
  status: string;
  params: unknown;
  result: unknown;
}

/** The prepare job `jobId` IF it was made for this very device by the print dialog. Anything else (another device, the website) is "not found". */
export async function loadGatewayPrepareJob(db: SupabaseClient<Database>, jobId: string, deviceId: string): Promise<GatewayPrepareJob | null> {
  const { data } = await db.from("server_jobs").select("id, status, params, result").eq("id", jobId).eq("kind", PREPARE_KIND).maybeSingle();
  if (!data) return null;
  const options = (data.params as { finish?: { options?: { deviceId?: string; source?: string } } } | null)?.finish?.options;
  return options?.deviceId === deviceId && options?.source === "ipp" ? data : null;
}

/** What the gateway's status call says about a prepare job. `null` = the print job now exists: read that instead. */
export function gatewayStatusOfPrepare(job: GatewayPrepareJob): { status: "draft" | "denied" | "cancelled"; message?: string } | null {
  const view = viewFromRow(job, true);
  switch (view.state) {
    case "done":
      return null;
    case "preparing":
      return { status: "draft" }; // the gateway words this itself: "Printio is getting this job ready"
    case "cancelled":
      return { status: "cancelled" };
    case "failed":
      return { status: "denied", message: view.fieldError ?? view.message };
    case "needs_booklet_confirm":
      // The print dialog confirms padding up front, so this should not happen; say something plain rather than wait forever.
      return { status: "denied", message: "This booklet needs blank pages added. Open Printio to print it." };
  }
}
