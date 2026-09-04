/** Storage path convention (docs/architecture.md sec 3.3). Shared by upload,
 *  signed-download, and retention-sweep code so the convention lives in one
 *  place. */
export const PRINT_JOBS_BUCKET = "print-jobs";

export function jobFilePath(organizationId: string, jobId: string, kind: "original" | "derived"): string {
  return `org/${organizationId}/jobs/${jobId}/${kind}.pdf`;
}
