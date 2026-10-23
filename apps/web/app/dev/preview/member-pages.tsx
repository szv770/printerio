import { AdminFrame } from "@/components/shell/AdminFrame";
import { MemberHeader } from "@/components/shell/MemberHeader";
import { Collapsible, PageHeader } from "@/components/ui";
import { FileText, History } from "lucide-react";
import type { Tables } from "@/lib/database.types";
import { PrintForm } from "@/app/(dashboard)/print/PrintForm";
import { JobStatusLive } from "@/app/(dashboard)/jobs/[id]/JobStatusLive";
import { CancelJobButton } from "@/app/(dashboard)/jobs/[id]/CancelJobButton";
import { RetryJobButton } from "@/app/(dashboard)/jobs/[id]/RetryJobButton";
import { ReprintButton } from "@/app/(dashboard)/jobs/[id]/ReprintButton";
import { SetupFeedbackCard } from "@/components/devices/SetupFeedbackCard";
import { AddressCardPreview, DevicesView, type DeviceItem } from "@/app/(dashboard)/devices/DevicesView";
import { UsageView } from "@/app/(dashboard)/usage/UsageView";
import { ProfileView } from "@/app/(dashboard)/profile/ProfileView";
import { JobListItem } from "@/app/(dashboard)/jobs/JobListItem";
import type { JobRow } from "@/app/(dashboard)/jobs/JobsList";

/** DEV-ONLY sample data for the teacher-side pages. Nothing here touches auth or the database. */

const USER = { name: "Dana Kaplan", email: "dana@lecfl.com", roleLabel: "Staff" };
const ID = "preview-user";

/** Same wrapper classes as components/shell/AppShell.tsx (member branch), so --sticky-bottom and the tab bar padding match. */
export function MemberFrame({ path, children }: { path: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen pb-[calc(4.5rem+env(safe-area-inset-bottom))] [--sticky-bottom:calc(5.25rem+env(safe-area-inset-bottom))] sm:pb-0 sm:[--sticky-bottom:1rem]">
      <MemberHeader userId={ID} isSuperAdmin={false} user={USER} pathnameOverride={path} />
      {children}
    </div>
  );
}

export function Framed({ shell, path, children }: { shell?: string; path: string; children: React.ReactNode }) {
  if (shell === "admin") {
    return (
      <AdminFrame isOrgAdmin isSuperAdmin={false} userId={ID} pendingApprovals={2} user={{ ...USER, roleLabel: "Admin" }} pathnameOverride={path}>
        {children}
      </AdminFrame>
    );
  }
  return <MemberFrame path={path}>{children}</MemberFrame>;
}

const CAPS = { duplex: true, color: true, staple: true, booklet: true, punch: true };
const ONE_PRINTER = [
  { id: "p1", label: "Main office - Kyocera MZ8500i", description: "Second floor copy room", isRaw: false, declaredPaperSizes: ["letter", "11x17", "legal"], declaredCapabilities: CAPS, printerOnline: true },
];
const RAW_PRINTER = [{ ...ONE_PRINTER[0]!, isRaw: true, label: "Kyocera MZ8500i" }];
const TWO_PRINTERS = [
  ...ONE_PRINTER,
  { id: "p2", label: "Library - HP LaserJet", description: null, isRaw: false, declaredPaperSizes: ["letter"], declaredCapabilities: { ...CAPS, staple: false, booklet: false, punch: false }, printerOnline: false },
];

export function PrintPreview({ shell, variant }: { shell?: string; variant?: string }) {
  const printers = variant === "raw" ? RAW_PRINTER : variant === "two" ? TWO_PRINTERS : ONE_PRINTER;
  return (
    <Framed shell={shell} path="/print">
      <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
        <PageHeader title="Print a document" description="Choose a PDF, check the basics, press Print." />
        <PrintForm printerProfiles={printers} maxUploadBytes={25 * 1024 * 1024} />
      </main>
    </Framed>
  );
}

const NOW = Date.now();
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

function sampleJob(over: Partial<Tables<"print_jobs">>): Tables<"print_jobs"> {
  return {
    id: "job-1",
    job_number: "PR-1042",
    original_file_name: "Grade 7 science quiz - unit 4 (final).pdf",
    status: "printing",
    source_pdf_pages: 12,
    color_mode: "bw",
    duplex: true,
    copies: 28,
    policy_action: "allow",
    policy_reasons: [],
    error_message: null,
    held_reason: null,
    is_test_print: false,
    files_purged_at: null,
    created_at: ago(6),
    updated_at: ago(1),
    attempt_count: 1,
    max_attempts: 3,
    estimated_printed_sides: 336,
    estimated_physical_sheets: 168,
    file_size_bytes: 482000,
    finishing: { staple: true },
    staple_position: "top-left",
    booklet_binding_side: null,
    page_range: null,
    policy_bypassed_for_admin: false,
    expires_at: null,
    ...over,
  } as unknown as Tables<"print_jobs">;
}

const EVENTS: Record<string, string[]> = {
  printing: ["created", "approved", "claimed", "downloaded", "printing"],
  completed: ["created", "approved", "claimed", "downloaded", "printing", "completed"],
  failed: ["created", "approved", "claimed", "failed"],
  pending_approval: ["created"],
};

export function JobPreview({ shell, variant = "printing" }: { shell?: string; variant?: string }) {
  const job =
    variant === "completed"
      ? sampleJob({ status: "completed", updated_at: ago(2) })
      : variant === "failed"
        ? sampleJob({ status: "failed", error_message: "The printer is offline. Check that it is switched on and has paper.", updated_at: ago(3) })
        : variant === "approval"
          ? sampleJob({ status: "pending_approval", policy_action: "require_approval", policy_reasons: ["More than 100 copies needs approval"], updated_at: ago(30) })
          : sampleJob({});
  const types = EVENTS[job.status] ?? EVENTS.printing!;
  const canRetry = job.status === "failed";
  const canCancel = ["pending_approval", "failed"].includes(job.status);
  const atPrinter = job.status === "printing";
  const reprintIsPrimary = job.status === "completed";
  const actions = (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
      {canRetry && <RetryJobButton jobId={job.id} big />}
      {reprintIsPrimary ? <ReprintButton jobId={job.id} big primary /> : <ReprintButton jobId={job.id} big />}
      {canCancel && <CancelJobButton jobId={job.id} big />}
      {atPrinter && <p className="text-sm text-[var(--color-muted)]">This job has already gone to the printer. Clear it at the printer.</p>}
    </div>
  );
  return (
    <Framed shell={shell} path="/jobs">
      <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
        <p className="-ml-2 mb-3 inline-flex min-h-11 items-center px-2 text-sm font-medium text-[var(--color-muted)]">&lsaquo; My jobs</p>
        <div className="mb-5">
          <h1 className="break-words text-xl font-semibold leading-7 sm:text-2xl sm:leading-8">{job.original_file_name}</h1>
          <p className="mt-0.5 text-sm text-[var(--color-muted)]">{job.job_number} · Sent 6 minutes ago</p>
        </div>
        <JobStatusLive job={job} eventTypes={types} rejectionReason={null} actions={actions} />
        <div className="mt-4 flex flex-col gap-3">
          <Collapsible
            id="job-details"
            title="Details"
            icon={<FileText className="h-4 w-4" aria-hidden="true" />}
            summary="12 pages · 28 copies · double-sided"
          >
            <p className="text-sm">(details grid)</p>
          </Collapsible>
          <Collapsible id="job-history" title="History" icon={<History className="h-4 w-4" aria-hidden="true" />} summary={`${types.length} steps · latest: ${types[types.length - 1]}`}>
            <p className="text-sm">(history list)</p>
          </Collapsible>
        </div>
      </main>
    </Framed>
  );
}

const LIST: JobRow[] = [
  { id: "j1", job_number: "PR-1042", original_file_name: "Grade 7 science quiz - unit 4 (final).pdf", status: "printing", source_pdf_pages: 12, color_mode: "bw", duplex: true, copies: 28, policy_action: null, policy_reasons: [], error_message: null, held_reason: null, is_test_print: false, created_at: ago(3), updated_at: ago(1) },
  { id: "j4", job_number: "PR-1037", original_file_name: "Queue test page", status: "failed", source_pdf_pages: 1, color_mode: "color", duplex: false, copies: 1, policy_action: null, policy_reasons: [], error_message: "The printer is offline.", held_reason: null, is_test_print: false, created_at: ago(1500), updated_at: ago(1500) },
];

export function JobListPreview({ shell }: { shell?: string }) {
  return (
    <Framed shell={shell} path="/jobs">
      <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
        <PageHeader title="My jobs" />
        <ul className="flex flex-col gap-3">
          {LIST.map((j) => (
            <JobListItem key={j.id} job={j} eventTypes={["created", "approved", "claimed"]} />
          ))}
        </ul>
      </main>
    </Framed>
  );
}

const DEVICES: DeviceItem[] = [
  { id: "d1", name: "My Pixel", device_type: "android", created_at: ago(60 * 24 * 12), revoked_at: null, last_seen_at: ago(20), first_job_at: ago(60 * 24 * 11), first_printed_at: ago(60 * 24 * 11), open_issues: 0 },
  { id: "d2", name: "Classroom laptop", device_type: "windows", created_at: ago(60 * 24 * 2), revoked_at: null, last_seen_at: null, first_job_at: null, first_printed_at: null, open_issues: 1 },
  { id: "d3", name: "Old Chromebook", device_type: "chromebook", created_at: ago(60 * 24 * 90), revoked_at: ago(60 * 24 * 5), last_seen_at: ago(60 * 24 * 6), first_job_at: null, first_printed_at: null },
];

export function DevicesPreview({ shell, variant }: { shell?: string; variant?: string }) {
  return (
    <Framed shell={shell} path="/devices">
      <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
        <PageHeader
          title="My devices"
          description="Add your phone, tablet or laptop to print from its normal Print button. Each device gets its own private address."
        />
        {variant?.startsWith("address-") ? (
          <AddressCardPreview deviceType={variant.slice(8)} />
        ) : (
          <>
            {variant === "feedback" && <SetupFeedbackCard devices={[{ id: "d2", name: "Classroom laptop", device_type: "windows" }]} />}
            {variant === "feedback-mac" && <SetupFeedbackCard devices={[{ id: "d9", name: "My MacBook", device_type: "mac" }]} />}
            <DevicesView devices={variant === "empty" ? [] : DEVICES} />
          </>
        )}
      </main>
    </Framed>
  );
}

export function UsagePreview({ shell, variant }: { shell?: string; variant?: string }) {
  return (
    <Framed shell={shell} path="/usage">
      <UsageView used={variant === "high" ? 92 : 38} limit={variant === "none" ? null : 100} basis="physical_sheets" period="2026-10" />
    </Framed>
  );
}

export function ProfilePreview({ shell }: { shell?: string }) {
  return (
    <Framed shell={shell} path="/profile">
      <ProfileView displayName="Dana Kaplan" email="dana@lecfl.com" orgName="Lecfl Academy" role="Staff" department="Grade 7" hasMembership />
    </Framed>
  );
}
