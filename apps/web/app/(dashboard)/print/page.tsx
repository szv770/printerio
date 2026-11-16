import Link from "next/link";
import { redirect } from "next/navigation";
import { BookOpen, Library } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { PageHeader } from "@/components/ui";
import { DEFAULT_MAX_UPLOAD_BYTES } from "@/lib/pdf/client-precheck";
import { SharedFileHandoff } from "@/components/pwa/SharedFileHandoff";
import { BuiltBookletHandoff } from "@/components/print/BuiltBookletHandoff";
import { LinkImport } from "@/components/print/LinkImport";
import { PrintAgainHandoff } from "@/components/print/PrintAgainHandoff";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { logger } from "@/lib/logger";
import { PRINT_AGAIN_NOT_FOUND_MESSAGE, PRINT_AGAIN_PURGED_MESSAGE, resolvePrintAgain, type PrintAgainResult } from "@/lib/jobs/print-again";
import { canUseLinks } from "@/lib/sources/access";
import { PrintForm } from "./PrintForm";

// "Print from a link" fetches a file on the server (up to 30 s) and the upload then needs time too.
export const maxDuration = 60;

/** How long the link to the stored original stays valid: the browser fetches it as soon as the page loads. */
const AGAIN_FILE_URL_TTL_SECONDS = 300;

export default async function PrintPage({ searchParams }: { searchParams: Promise<{ again?: string | string[] }> }) {
  const session = await requireSessionOrRedirect();
  if (!session.membership) redirect(routes.noAccess);

  const supabase = await createClient();
  const againParam = (await searchParams).again;
  const againId = typeof againParam === "string" ? againParam.trim() : "";
  const [{ data: profiles }, { data: settings }] = await Promise.all([
    supabase
      .from("printer_profiles")
      .select(
        "id, label, key, description, declared_paper_sizes, declared_capabilities, output_mode, is_default, printers!inner(id, name, organization_id, status, status_detail)",
      )
      .eq("printers.organization_id", session.membership.organization_id)
      .order("is_default", { ascending: false }),
    // Only the upload limit is handed to the client, purely so the form can
    // say "too big" before a slow upload rather than after. The server action
    // re-reads this setting itself and remains the authority - see
    // print/actions.ts and lib/pdf/client-precheck.ts.
    supabase
      .from("organization_settings")
      .select("max_upload_size_bytes")
      .eq("organization_id", session.membership.organization_id)
      .maybeSingle(),
  ]);

  const printerProfiles = (profiles ?? []).map((p) => ({
    id: p.id,
    // A raw-port printer is just "the printer" to a member; only Windows-queue printers still need the
    // profile name to tell several queues on one printer apart.
    isRaw: p.output_mode === "raw",
    label: p.output_mode === "raw" ? p.printers.name : `${p.printers.name} — ${p.label}`,
    description: p.description,
    declaredPaperSizes: p.declared_paper_sizes,
    declaredCapabilities: p.declared_capabilities as {
      duplex: boolean;
      color: boolean;
      staple: boolean;
      booklet: boolean;
      punch: boolean;
    },
    printerOnline: p.printers.status === "online",
    printerStatus: p.printers.status,
    printerDetail: p.printers.status_detail,
  }));

  const maxUploadBytes = settings?.max_upload_size_bytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  // "Print again": the job is read through the member's own session AND filtered to their own job in their own
  // organization (the same scoping as reprintJobAction); the link to the stored file is minted only after that.
  // Any failure becomes a plain note above the ordinary empty form - this never throws.
  let again: Extract<PrintAgainResult, { kind: "ok" }> | null = null;
  let againFileUrl: string | null = null;
  let againNotice: string | null = null;
  if (againId) {
    try {
      const { data: job } = await supabase
        .from("print_jobs")
        .select("*")
        .eq("id", againId)
        .eq("created_by", session.userId)
        .eq("organization_id", session.membership.organization_id)
        .maybeSingle();
      const resolved = resolvePrintAgain(job, { userId: session.userId, role: session.membership.role, organizationId: session.membership.organization_id });
      if (resolved.kind === "ok") {
        const { data: signed } = await createServiceRoleClient().storage.from(PRINT_JOBS_BUCKET).createSignedUrl(resolved.filePath, AGAIN_FILE_URL_TTL_SECONDS);
        if (signed?.signedUrl) {
          again = resolved;
          againFileUrl = signed.signedUrl;
        } else {
          againNotice = PRINT_AGAIN_PURGED_MESSAGE;
        }
      } else {
        againNotice = resolved.message;
      }
    } catch (err) {
      logger.error("print again could not load the job", { jobId: againId, error: err instanceof Error ? err.message : String(err) });
      againNotice = PRINT_AGAIN_NOT_FOUND_MESSAGE;
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
      <PageHeader title="Print a document" description="Choose a PDF, check the basics, press Print." />
      {/* Always render the form, even with zero printer_profiles - it shows
       *  its own inline notice and disables Submit in that case, rather than
       *  blocking the user from picking a file and preparing everything
       *  else just because a printer isn't connected yet. */}
      {again && againFileUrl && <PrintAgainHandoff banner={again.banner} fileName={again.fileName} fileUrl={againFileUrl} />}
      {againNotice && (
        <p role="status" className="mb-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3.5 text-sm">
          {againNotice}
        </p>
      )}
      <SharedFileHandoff maxUploadBytes={maxUploadBytes} />
      <BuiltBookletHandoff />
      {canUseLinks(session.membership.role, session.membership.early_tools) && (
        <div className="flex flex-wrap items-start gap-x-3">
          <LinkImport maxUploadBytes={maxUploadBytes} />
          <Link
            href="/print/booklet"
            className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
          >
            <BookOpen className="h-4 w-4" aria-hidden="true" />
            Make a booklet from several files
          </Link>
          <Link
            href="/print/library"
            className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
          >
            <Library className="h-4 w-4" aria-hidden="true" />
            Library
          </Link>
        </div>
      )}
      <PrintForm printerProfiles={printerProfiles} maxUploadBytes={maxUploadBytes} blockType3Fonts={process.env.PRINTIO_ALLOW_TYPE3_FONTS !== "1"} again={again?.choices} />
    </main>
  );
}
