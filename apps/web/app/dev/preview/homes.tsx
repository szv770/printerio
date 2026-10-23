import Link from "next/link";
import { AlertTriangle, ChevronRight, Clock, Plus, Printer, ServerCrash } from "lucide-react";
import { AdminFrame } from "@/components/shell/AdminFrame";
import { MemberHeader } from "@/components/shell/MemberHeader";
import { ButtonLink, Card, PageHeader, StatusDot, type StatusTone } from "@/components/ui";
import { JobStatusBadge } from "@/app/(dashboard)/jobs/JobStatusBadge";

/** Sketches of the two home screens, with hard-coded sample data (dev preview only). */

const USER = { name: "Dana Kaplan", email: "dana@lecfl.com", roleLabel: "Admin" };

const RECENT = [
  { name: "Grade 7 science quiz - unit 4 (final).pdf", status: "printing", meta: "12 pages · 28 copies · 3 min ago" },
  { name: "Parent letter.pdf", status: "pending_approval", meta: "2 pages · 120 copies · 40 min ago" },
  { name: "Field trip permission slip.pdf", status: "completed", meta: "1 page · 30 copies · 5 h ago" },
];

function RecentRows() {
  return (
    <ul className="flex flex-col gap-2">
      {RECENT.map((j) => (
        <li key={j.name}>
          <Link
            href="/jobs"
            className="flex min-h-16 items-center gap-3 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-[var(--shadow-xs)] hover:border-[var(--color-border-strong)]"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium">{j.name}</span>
              <span className="block truncate text-xs text-[var(--color-muted)]">{j.meta}</span>
            </span>
            <span className="shrink-0">
              <JobStatusBadge status={j.status} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function BigPrint({ hint }: { hint: string }) {
  return (
    <Link
      href="/print"
      className="flex items-center gap-4 rounded-[var(--radius-card)] bg-[var(--color-primary)] p-5 text-[var(--color-primary-fg)] shadow-[inset_0_1px_0_rgb(255_255_255/0.2),var(--shadow-card)] transition-colors hover:bg-[var(--color-primary-hover)] sm:p-6"
    >
      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/15">
        <Printer className="h-7 w-7" />
      </span>
      <span>
        <span className="block text-xl font-bold tracking-[-0.02em]">Print a document</span>
        <span className="mt-0.5 block text-sm opacity-90">{hint}</span>
      </span>
    </Link>
  );
}

const ATTENTION: Array<{ tone: StatusTone; icon: typeof Clock; title: string; note: string; href: string; action: string }> = [
  { tone: "warning", icon: Clock, title: "3 jobs waiting for approval", note: "The oldest has waited 40 minutes.", href: "/admin/approvals", action: "Review" },
  { tone: "danger", icon: AlertTriangle, title: "2 prints failed today", note: "Queue test page, Grade 9 handout.", href: "/admin/reports", action: "See why" },
  { tone: "danger", icon: ServerCrash, title: "Library printer is offline", note: "5 jobs are waiting in its queue.", href: "/admin/printers", action: "Check" },
];

const LIVE: Array<{ tone: StatusTone; name: string; state: string }> = [
  { tone: "live", name: "Main office", state: "Printing PR-1042 (page 5 of 12)" },
  { tone: "success", name: "Teachers room", state: "Ready" },
  { tone: "danger", name: "Library", state: "Offline" },
  { tone: "success", name: "Print server", state: "Connected" },
];

export function AdminHomeSection() {
  return (
    <AdminFrame isOrgAdmin isSuperAdmin userId="preview-user" pendingApprovals={3} user={USER} pathnameOverride="/admin">
      <PageHeader title="Good morning, Dana" description="Here is what needs you and what is printing right now." />

      <section aria-labelledby="needs" className="mb-6">
        <h2 id="needs" className="mb-3 text-base font-bold tracking-[-0.01em]">
          Needs attention
        </h2>
        <Card className="p-0 sm:p-0">
          <ul className="divide-y divide-[var(--color-border)]">
            {ATTENTION.map((a) => (
              <li key={a.title}>
                <Link
                  href={a.href}
                  className="flex min-h-16 items-center gap-3 px-4 py-3 first:rounded-t-[var(--radius-card)] last:rounded-b-[var(--radius-card)] hover:bg-[var(--color-surface-2)]/60 sm:px-5"
                >
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                      a.tone === "warning" ? "bg-[#fdf1cf] text-[#7a5600]" : "bg-[#fbe3ee] text-[#a21a58]"
                    }`}
                  >
                    <a.icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-medium">{a.title}</span>
                    <span className="block truncate text-[13px] text-[var(--color-muted)]">{a.note}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5 text-sm font-medium text-[var(--color-primary)]">
                    <span className="hidden sm:inline">{a.action}</span>
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section aria-labelledby="now" className="mb-6">
        <h2 id="now" className="mb-3 text-base font-bold tracking-[-0.01em]">
          Right now
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {LIVE.map((l) => (
            <li
              key={l.name}
              className="flex min-h-14 items-center justify-between gap-3 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 shadow-[var(--shadow-xs)]"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{l.name}</span>
                <span className="block truncate text-xs text-[var(--color-muted)]">{l.state}</span>
              </span>
              <StatusDot tone={l.tone}>
                {l.tone === "live" ? "Busy" : l.tone === "danger" ? "Offline" : "OK"}
              </StatusDot>
            </li>
          ))}
        </ul>
      </section>

      <div className="mb-6">
        <BigPrint hint="Upload a PDF and choose a printer and options." />
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
        <RecentRows />
      </section>
    </AdminFrame>
  );
}

export function TeacherHomeSection() {
  return (
    <div className="min-h-screen pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:pb-0">
      <MemberHeader userId="preview-user" isSuperAdmin={false} user={{ ...USER, roleLabel: "Staff" }} pathnameOverride="/home" />
      <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
        <h1 className="mb-4 text-2xl font-bold tracking-[-0.03em]">Hi Dana</h1>
        <div className="mb-5">
          <BigPrint hint="Upload a PDF and choose your options." />
        </div>
        <div className="mb-6 grid grid-cols-2 gap-3">
          <Card className="p-4 sm:p-4">
            <p className="text-[13px] text-[var(--color-muted)]">Pages left this month</p>
            <p className="mt-1 text-2xl font-bold tracking-[-0.02em] tabular-nums">412</p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
              <div className="h-full w-[38%] rounded-full bg-[var(--ink-c)]" />
            </div>
          </Card>
          <Card className="p-4 sm:p-4">
            <p className="text-[13px] text-[var(--color-muted)]">Printing now</p>
            <p className="mt-1 text-2xl font-bold tracking-[-0.02em] tabular-nums">1</p>
            <p className="mt-2.5 text-xs text-[var(--color-faint)]">
              <Plus className="mr-1 inline h-3 w-3" aria-hidden="true" />1 waiting for approval
            </p>
          </Card>
        </div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold tracking-[-0.01em]">Your last jobs</h2>
          <ButtonLink href="/jobs" variant="ghost" size="sm">
            View all
          </ButtonLink>
        </div>
        <RecentRows />
      </main>
    </div>
  );
}
