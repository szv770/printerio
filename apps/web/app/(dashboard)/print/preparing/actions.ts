"use server";

import { redirect } from "next/navigation";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { cancelPrepareJob } from "@/lib/prepare/cancel";
import { confirmBookletForPrepareJob } from "@/lib/prepare/confirm";
import { routes } from "@/lib/routes";

export interface PrepareActionState {
  error?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (formData: FormData) => {
  const id = String(formData.get("jobId") ?? "");
  return UUID.test(id) ? id : null;
};

/** Cancel a file that is still waiting for or being prepared by the print server. Only the sender's own job (lib/prepare/cancel.ts). */
export async function cancelPrepareAction(_prev: PrepareActionState, formData: FormData): Promise<PrepareActionState> {
  const session = await requireSessionOrRedirect();
  const id = idOf(formData);
  if (!id) return { error: "That job was not found." };
  const out = await cancelPrepareJob(createServiceRoleClient(), session.userId, id);
  if (out.ok) redirect(routes.print);
  if (out.reason === "too_late" && out.printJobId) redirect(routes.job(out.printJobId)); // it finished first: cancel it there like any job
  return { error: "That job was not found." };
}

/** "Yes, add the blank pages" for a booklet. Puts the same job back in the queue; the page then shows preparing again. */
export async function confirmPrepareBookletAction(_prev: PrepareActionState, formData: FormData): Promise<PrepareActionState> {
  const session = await requireSessionOrRedirect();
  const id = idOf(formData);
  if (!id) return { error: "That job was not found." };
  const ok = await confirmBookletForPrepareJob(createServiceRoleClient(), session.userId, id);
  if (!ok) return { error: "This file can no longer be changed. Go back and submit it again." };
  redirect(routes.preparing(id));
}
