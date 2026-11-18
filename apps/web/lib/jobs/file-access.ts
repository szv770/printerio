/**
 * Who may open a print job's stored PDF, and which file. The person who sent the job and the admins/approvers of the SAME
 * organization may; nobody else, never across organizations, and a platform super admin gets nothing just for being one
 * (docs/SECURITY.md, "Who can see documents"). The files exist only until the retention window ends or the sender deletes them.
 */
export type FileWhich = "original" | "sent";

export interface JobFileViewer {
  userId: string;
  /** The viewer's role in their organization, or null when they have no active membership. */
  role: string | null;
  organizationId: string | null;
}

export interface JobFileRow {
  organization_id: string;
  created_by: string;
  original_file_path: string | null;
  derived_file_path: string | null;
  files_purged_at: string | null;
}

const ADMIN_ROLES = new Set(["org_admin", "approver"]);

export function canViewJobFile(viewer: JobFileViewer, job: Pick<JobFileRow, "organization_id" | "created_by">): boolean {
  if (!viewer.organizationId || !viewer.role) return false;
  if (viewer.organizationId !== job.organization_id) return false;
  return viewer.userId === job.created_by || ADMIN_ROLES.has(viewer.role);
}

export function parseFileWhich(value: string | null): FileWhich {
  return value === "sent" ? "sent" : "original";
}

/** The storage path to open, or null when the file is gone. "sent" is the PDF Printio built for the printer (falls back to the original). */
export function jobFilePath(job: Pick<JobFileRow, "original_file_path" | "derived_file_path" | "files_purged_at">, which: FileWhich): string | null {
  if (job.files_purged_at) return null;
  const path = which === "sent" ? job.derived_file_path || job.original_file_path : job.original_file_path;
  return path ? path : null;
}
