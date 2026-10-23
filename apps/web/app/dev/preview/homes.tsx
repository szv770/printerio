import { AdminFrame } from "@/components/shell/AdminFrame";
import { MemberHeader } from "@/components/shell/MemberHeader";
import { ButtonLink, PageHeader } from "@/components/ui";
import { BigPrintCard } from "@/components/home/BigPrintCard";
import { NeedsAttention } from "@/components/home/NeedsAttention";
import { RightNow } from "@/components/home/RightNow";
import { RecentJobs, type RecentJobRow } from "@/components/home/RecentJobs";
import { SetupCard } from "@/components/home/SetupCard";
import { StatusCards } from "@/components/home/StatusCards";
import { setupChecklist } from "@/lib/admin-setup-checklist";
import { buildAttentionItems, buildRightNow } from "@/lib/home/admin-home";
import { quotaCard, statusCards, teacherEmptyText } from "@/lib/home/teacher-home";

/** The two home screens fed with hard-coded sample data (dev preview only): same components and logic as the real pages. */

const USER = { name: "Dana Kaplan", email: "dana@lecfl.com", roleLabel: "Admin" };
const NOW = new Date("2026-03-10T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

const RECENT: RecentJobRow[] = [
  { id: "1", href: "/jobs", name: "Grade 7 science quiz - unit 4 (final).pdf", status: "printing", meta: "12 pages · 28 copies · 3 min ago" },
  { id: "2", href: "/jobs", name: "Parent letter.pdf", status: "pending_approval", meta: "2 pages · 120 copies · 40 min ago" },
  { id: "3", href: "/jobs", name: "Field trip permission slip.pdf", status: "completed", meta: "1 page · 30 copies · 5 h ago" },
];

const AGENTS = [{ id: "a1", name: "Front office PC", lastSeenAt: ago(0.4) }];
const PRINTERS = [
  { id: "p1", name: "Main office", status: "online" },
  { id: "p2", name: "Teachers room", status: "online" },
  { id: "p3", name: "Library", status: "offline" },
];

export function AdminHomeSection({ variant = "busy" }: { variant?: "busy" | "clear" | "setup" }) {
  const busy = variant === "busy";
  const attention = buildAttentionItems({
    now: NOW,
    pendingApprovals: busy ? { count: 3, oldestCreatedAt: ago(40) } : { count: 0, oldestCreatedAt: null },
    failed: busy
      ? { count: 2, recent: [{ name: "Queue test page.pdf", errorMessage: null }, { name: "Grade 9 handout.pdf", errorMessage: null }] }
      : { count: 0, recent: [] },
    agents: AGENTS,
    printers: busy ? PRINTERS : PRINTERS.map((p) => ({ ...p, status: "online" })),
    heldCount: busy ? 1 : 0,
    stuckDevices: busy ? 2 : 0,
  });
  const rightNow = buildRightNow({
    now: NOW,
    agents: AGENTS,
    printers: busy ? PRINTERS : PRINTERS.map((p) => ({ ...p, status: "online" })),
    activeJobs: busy ? [{ id: "j1", jobNumber: "PR-1042", printerId: "p1", status: "printing", pages: 12, copies: 28 }] : [],
  });
  const steps = setupChecklist(
    { agents: 1, onlineAgents: 1, printers: 0, printerProfiles: 0, members: 1, policies: 0, quotas: 0 },
    { agents: "/admin/agents", printersSetup: "/admin/printers/setup", users: "/admin/users", policies: "/admin/policies" },
  );
  return (
    <AdminFrame isOrgAdmin isSuperAdmin userId="preview-user" pendingApprovals={busy ? 3 : 0} user={USER} pathnameOverride="/admin">
      <PageHeader title="Hi, Dana" description="Here is what needs you and what is printing right now." />
      {variant === "setup" && <SetupCard steps={steps} />}
      <NeedsAttention items={attention} />
      <RightNow rows={rightNow} />
      <div className="mb-6">
        <BigPrintCard hint="Upload a PDF and choose a printer and options." />
      </div>
      <section aria-labelledby="recent">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="recent" className="text-base font-bold tracking-[-0.01em]">
            Recent jobs
          </h2>
          <ButtonLink href="/admin/reports" variant="ghost" size="sm">
            View all
          </ButtonLink>
        </div>
        <RecentJobs jobs={busy ? RECENT : []} emptyText="No prints yet. Jobs show up here as soon as someone prints." />
      </section>
    </AdminFrame>
  );
}

export function TeacherHomeSection({ variant = "quota" }: { variant?: "quota" | "noquota" | "empty" }) {
  const quota = variant === "quota" ? quotaCard({ limit: 665, used: 253, basis: "pdf_pages" }) : null;
  const cards = statusCards({ quota, printing: variant === "empty" ? 0 : 1, waiting: variant === "empty" ? 0 : 1 });
  return (
    <div className="min-h-screen pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:pb-0">
      <MemberHeader userId="preview-user" isSuperAdmin={false} user={{ ...USER, roleLabel: "Staff" }} pathnameOverride="/home" />
      <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
        <h1 className="mb-4 text-2xl font-bold tracking-[-0.03em]">Hi Dana</h1>
        <div className="mb-5">
          <BigPrintCard hint="Upload a PDF and choose your options." />
        </div>
        <StatusCards cards={cards} />
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold tracking-[-0.01em]">Your last jobs</h2>
          {variant !== "empty" && (
            <ButtonLink href="/jobs" variant="ghost" size="sm">
              View all
            </ButtonLink>
          )}
        </div>
        <RecentJobs jobs={variant === "empty" ? [] : RECENT} emptyText={teacherEmptyText()} />
      </main>
    </div>
  );
}
