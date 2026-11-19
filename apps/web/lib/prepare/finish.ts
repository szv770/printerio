import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { readWire, type PrepareJobParams, type PrepareWire } from "@printio/pdf/prepare-wire";
import { finishPrintJob, resolveJobPlan, type JobOptions, type JobSession } from "@/lib/jobs/create-print-job";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { logger } from "@/lib/logger";
import { MAX_REASON_CHARS, PREPARE_KIND } from "./prepare-jobs";

/**
 * Step two of the print-server path (docs/PREPARE-JOBS-DESIGN.md, plan P2b): the print server reported what it did with the file, and the website now
 * turns that into a real print job, deciding the rules, quota and approval on the REAL page count. The files are already in storage, so they are moved
 * into their usual place, not uploaded. Safe to run twice for the same prepare job (the print job takes the prepare job's id, and an existing one is
 * returned as it is), so a retry after a crash cannot create a second job.
 */
export type PrepareJobRow = { id: string; organization_id: string; requested_by: string; source_path: string; params: unknown };

export type FinishOutcome =
  | { status: "finished"; printJobId: string }
  | { status: "already_finished"; printJobId: string }
  | { status: "needs_booklet_confirm" }
  | { status: "failed"; error: string };

type Db = SupabaseClient<Database>;

async function removeObjects(db: Db, paths: Array<string | null | undefined>): Promise<void> {
  const real = paths.filter((p): p is string => typeof p === "string" && p !== "");
  if (real.length === 0) return;
  try {
    await db.storage.from(PRINT_JOBS_BUCKET).remove(real);
  } catch (err) {
    logger.warn("could not remove files of a prepare job", { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Marks the prepare job failed with a plain reason the sender will see, and clears what it left in storage. */
async function failJob(db: Db, job: PrepareJobRow, error: string, wire: PrepareWire | null, cleanup: Array<string | null | undefined>): Promise<FinishOutcome> {
  // Two finishes can race (the retry sweep and the print server's own call). The loser fails on the print job's primary key; it must NOT mark the
  // job failed or remove files when the winner already created the print job.
  const { data: winner } = await db.from("print_jobs").select("id").eq("id", job.id).maybeSingle();
  if (winner) return { status: "already_finished", printJobId: job.id };
  const message = error.slice(0, MAX_REASON_CHARS);
  const { error: updateError } = await db
    .from("server_jobs")
    .update({ status: "failed", error: message, lease_until: null, finished_at: new Date().toISOString(), ...(wire ? { result: wire as never } : {}) })
    .eq("id", job.id)
    .eq("organization_id", job.organization_id)
    .eq("kind", PREPARE_KIND);
  if (updateError) logger.error("could not mark a prepare job failed", { jobId: job.id, error: updateError.message });
  await removeObjects(db, [job.source_path, ...cleanup]);
  return { status: "failed", error: message };
}

export async function finishPrepareJob(db: Db, job: PrepareJobRow, wire: PrepareWire): Promise<FinishOutcome> {
  // A second run for the same job (a retry): the print job already exists, so there is nothing to do.
  const { data: existing } = await db.from("print_jobs").select("id").eq("id", job.id).maybeSingle();
  if (existing) return { status: "already_finished", printJobId: job.id };

  // A job the sender cancelled is never finished, however late this runs (a retry, a sweep): its files are cleaned up and nothing is created.
  const { data: current } = await db.from("server_jobs").select("status").eq("id", job.id).eq("organization_id", job.organization_id).eq("kind", PREPARE_KIND).maybeSingle();
  if (current?.status === "cancelled") {
    await removeObjects(db, [job.source_path, wire.preparedPath]);
    return { status: "failed", error: "The sender cancelled this file." };
  }

  const outcome = readWire(wire);
  switch (outcome.kind) {
    case "rejected":
      return failJob(db, job, outcome.reason, wire, [wire.preparedPath]);
    case "error":
      return failJob(db, job, outcome.error.message, wire, [wire.preparedPath]);
    case "incomplete":
      return failJob(db, job, "The print server's answer was incomplete. Please submit the file again.", null, [wire.preparedPath]);
    case "needs_booklet_confirm":
      // Not a failure: the person is asked, and the upload is kept for the retry. The job stays 'done' with the question in its result.
      await db
        .from("server_jobs")
        .update({ result: wire as never })
        .eq("id", job.id)
        .eq("organization_id", job.organization_id)
        .eq("kind", PREPARE_KIND);
      return { status: "needs_booklet_confirm" };
    case "prepared":
      break;
  }
  if (outcome.kind !== "prepared") return failJob(db, job, "Something went wrong preparing your file.", null, [wire.preparedPath]); // unreachable; narrows the type

  const params = job.params as Partial<PrepareJobParams> | null;
  if (!params || params.v !== 1 || !params.finish) return failJob(db, job, "This print request is out of date. Please submit the file again.", null, [wire.preparedPath]);
  const { originalFileName, options } = params.finish;

  // The person must still be an active member: the session is rebuilt from the database, never from the print server.
  const { data: member } = await db
    .from("organization_members")
    .select("role, department, status")
    .eq("user_id", job.requested_by)
    .eq("organization_id", job.organization_id)
    .maybeSingle();
  if (!member || member.status !== "active") return failJob(db, job, "You can no longer print here.", null, [wire.preparedPath]);
  const session: JobSession = { userId: job.requested_by, membership: { organization_id: job.organization_id, role: member.role, department: member.department } };

  const jobOptions = { ...(options as unknown as JobOptions), writeClient: db } as JobOptions;
  const planned = await resolveJobPlan(db, session, outcome.prepared.fileSizeBytes, jobOptions);
  if (!planned.ok) {
    const r = planned.result;
    return failJob(db, job, r.ok === false && r.kind === "error" ? r.error : "Something went wrong. Please submit the file again.", null, [wire.preparedPath]);
  }

  const result = await finishPrintJob(db, session, null, originalFileName, jobOptions, planned.plan, outcome.prepared, {
    jobId: job.id,
    originalPath: job.source_path,
    derivedPath: outcome.preparedPath,
  });
  if (!result.ok) {
    if (result.kind === "error") return failJob(db, job, result.error, null, [outcome.preparedPath]);
    return failJob(db, job, "Something went wrong. Please submit the file again.", null, [outcome.preparedPath]);
  }

  await db
    .from("server_jobs")
    .update({ status: "done", result: { ...(wire as object), printJobId: result.jobId, jobNumber: result.jobNumber, status: result.status } as never })
    .eq("id", job.id)
    .eq("organization_id", job.organization_id)
    .eq("kind", PREPARE_KIND);
  return { status: "finished", printJobId: result.jobId };
}
