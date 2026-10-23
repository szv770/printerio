import { Download, FileText, Inbox, Plus, Printer, RefreshCw, Trash2, Users } from "lucide-react";
import { AdminFrame } from "@/components/shell/AdminFrame";
import { MemberHeader } from "@/components/shell/MemberHeader";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  Input,
  PageHeader,
  ResponsiveTable,
  Select,
  Skeleton,
  Switch,
  Tabs,
  Textarea,
} from "@/components/ui";
import { SegmentedDemo } from "./Interactive";
import { SettingsPanel } from "@/app/admin/settings/SettingsPanel";
import { JobListItem } from "@/app/(dashboard)/jobs/JobListItem";
import type { JobRow } from "@/app/(dashboard)/jobs/JobsList";

/** Hard-coded sample data for the dev preview. Nothing here touches auth or the database. */

const USER = { name: "Dana Kaplan", email: "dana@lecfl.com", roleLabel: "Admin" };
const PREVIEW_USER_ID = "preview-user";

const NOW = Date.now();
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

const JOBS: JobRow[] = [
  { id: "j1", job_number: "PR-1042", original_file_name: "Grade 7 science quiz - unit 4 (final).pdf", status: "printing", source_pdf_pages: 12, color_mode: "bw", duplex: true, copies: 28, policy_action: null, policy_reasons: [], error_message: null, held_reason: null, is_test_print: false, created_at: ago(3), updated_at: ago(1) },
  { id: "j2", job_number: "PR-1041", original_file_name: "Parent letter.pdf", status: "pending_approval", source_pdf_pages: 2, color_mode: "color", duplex: false, copies: 120, policy_action: "require_approval", policy_reasons: ["More than 100 copies needs approval"], error_message: null, held_reason: null, is_test_print: false, created_at: ago(40), updated_at: ago(40) },
  { id: "j3", job_number: "PR-1039", original_file_name: "Field trip permission slip.pdf", status: "completed", source_pdf_pages: 1, color_mode: "bw", duplex: false, copies: 30, policy_action: null, policy_reasons: [], error_message: null, held_reason: null, is_test_print: false, created_at: ago(300), updated_at: ago(298) },
  { id: "j4", job_number: "PR-1037", original_file_name: "Queue test page", status: "failed", source_pdf_pages: 1, color_mode: "color", duplex: false, copies: 1, policy_action: null, policy_reasons: [], error_message: "The printer is offline.", held_reason: null, is_test_print: true, created_at: ago(1500), updated_at: ago(1500) },
];

const EVENTS: Record<string, string[]> = {
  j1: ["created", "approved", "claimed", "downloaded"],
  j2: ["created"],
  j3: ["created", "approved", "claimed", "downloaded", "printing", "completed"],
  j4: ["created", "approved", "claimed", "failed"],
};

const PRINTERS = [
  { name: "Main office (Kyocera MZ8500i)", status: "Online", pages: 18420, queue: 2 },
  { name: "Teachers room (Brother HL-L8)", status: "Online", pages: 6310, queue: 0 },
  { name: "Library (HP LaserJet)", status: "Offline", pages: 904, queue: 5 },
];

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Card>
      <p className="text-[13px] text-[var(--color-muted)]">{label}</p>
      <p className="mt-1 text-[1.75rem] leading-9 font-semibold tracking-[-0.02em] tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-[var(--color-faint)]">{note}</p>
    </Card>
  );
}

export function AdminSection({ path }: { path: string }) {
  return (
    <AdminFrame isOrgAdmin isSuperAdmin userId={PREVIEW_USER_ID} pendingApprovals={3} user={USER} pathnameOverride={path}>
      <PageHeader
        title="Overview"
        description="What is printing now, what needs you, and how the month is going."
        action={
          <ButtonLink href="/print" variant="secondary" size="sm">
            <Download className="h-4 w-4" aria-hidden="true" />
            Export report
          </ButtonLink>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Pages this month" value="8,214" note="of 20,000 allowed" />
        <Stat label="Jobs today" value="47" note="3 waiting on approval" />
        <Stat label="Active users" value="62" note="of 140 accounts" />
        <Stat label="Failed jobs" value="2" note="last 7 days" />
      </div>
      <h2 className="mt-8 mb-3 text-base font-semibold">Printers</h2>
      <ResponsiveTable
        caption="Printers"
        rows={PRINTERS}
        rowKey={(r) => r.name}
        columns={[
          { header: "Printer", primary: true, cell: (r) => r.name },
          { header: "Status", cell: (r) => <Badge tone={r.status === "Online" ? "success" : "danger"}>{r.status}</Badge> },
          { header: "In queue", align: "right", cell: (r) => r.queue },
          { header: "Pages printed", align: "right", cell: (r) => r.pages.toLocaleString("en-US") },
        ]}
      />
    </AdminFrame>
  );
}

export function MemberSection({ path }: { path: string }) {
  return (
    <div className="min-h-screen">
      <MemberHeader userId={PREVIEW_USER_ID} isSuperAdmin={false} user={{ ...USER, roleLabel: "Staff" }} pathnameOverride={path} />
      <main className="mx-auto max-w-2xl px-4 py-8 sm:py-10">
        <PageHeader
          title="My jobs"
          action={
            <ButtonLink href="/print" size="sm">
              <Plus className="h-4 w-4" aria-hidden="true" />
              New print job
            </ButtonLink>
          }
        />
        <ul className="flex flex-col gap-3">
          {JOBS.slice(0, 2).map((j) => (
            <JobListItem key={j.id} job={j} eventTypes={EVENTS[j.id]} />
          ))}
        </ul>
      </main>
    </div>
  );
}

export function JobsSection() {
  const pills: Array<[string, number, boolean]> = [
    ["All", 4, true],
    ["In progress", 1, false],
    ["Needs attention", 2, false],
    ["Done", 1, false],
  ];
  return (
    <AdminFrame isOrgAdmin={false} isSuperAdmin={false} userId={PREVIEW_USER_ID} pendingApprovals={0} user={{ ...USER, roleLabel: "Approver" }} pathnameOverride="/jobs">
      <PageHeader
        title="My jobs"
        action={
          <ButtonLink href="/print" size="sm">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New print job
          </ButtonLink>
        }
      />
      <div
        role="group"
        aria-label="Filter jobs"
        className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden"
      >
        {pills.map(([label, count, on]) => (
          <span
            key={label}
            className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium sm:min-h-9 sm:px-3.5 ${
              on
                ? "border-[var(--color-text)] bg-[var(--color-text)] text-white"
                : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-2)]"
            }`}
          >
            {label}
            <span className={`text-xs tabular-nums ${on ? "text-white/70" : "text-[var(--color-faint)]"}`}>{count}</span>
          </span>
        ))}
      </div>
      <ul className="flex flex-col gap-3">
        {JOBS.map((j) => (
          <JobListItem key={j.id} job={j} eventTypes={EVENTS[j.id]} />
        ))}
      </ul>
      <div className="mt-8">
        <EmptyState
          icon={FileText}
          title="No print jobs yet"
          description="Documents you print show up here, with live progress."
          action={
            <ButtonLink href="/print">
              <Plus className="h-4 w-4" aria-hidden="true" />
              Print your first document
            </ButtonLink>
          }
        />
      </div>
    </AdminFrame>
  );
}

export function SettingsSection() {
  return (
    <AdminFrame isOrgAdmin isSuperAdmin={false} userId={PREVIEW_USER_ID} pendingApprovals={3} user={USER} pathnameOverride="/admin/settings">
      <PageHeader
        title="Settings"
        description="Who can join, how printing behaves by default, and the print stamp. Open a section to change it, then save."
      />
      <SettingsPanel
        allowedDomains={["lecfl.com", "staff.lecfl.com"]}
        joinMode="invite_or_domain"
        domainJoinRole="student"
        defaultBookletBindingSide="left"
        adminsBypassRestrictions
        autoRetryFailedPrints={false}
        stamp={{ enabled: true, show: "code_date", strength: "light" }}
        canManage
      />
    </AdminFrame>
  );
}

export function PrimitivesSection() {
  const variants = ["primary", "secondary", "ghost", "danger", "success", "outline", "outline-danger"] as const;
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <PageHeader title="Design primitives" description="Buttons, cards, fields, badges, tabs and empty states, as used on every page." />

      <Tabs
        label="Sample tabs"
        items={[
          { href: "#a", label: "Users", active: true },
          { href: "#b", label: "Groups" },
          { href: "#c", label: "Invites", badge: <Badge tone="warning">2</Badge> },
          { href: "#d", label: "Archived" },
        ]}
      />

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title="Buttons" description="Every variant, size and state." icon={Printer} />
          <CardBody>
            {(["default", "sm", "lg"] as const).map((size) => (
              <div key={size} className="flex flex-wrap items-center gap-2">
                {variants.map((v) => (
                  <Button key={v} variant={v} size={size}>
                    {v}
                  </Button>
                ))}
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled>Disabled</Button>
              <Button variant="secondary" disabled>
                Disabled
              </Button>
              <Button pending pendingLabel="Saving...">
                Save
              </Button>
              <Button variant="secondary">
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                With icon
              </Button>
              <Button variant="outline-danger">
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Delete
              </Button>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Fields" description="Labels above, help below, errors inline." />
          <CardBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Full name" htmlFor="p-name" help="As it appears on printed stamps.">
                <Input id="p-name" defaultValue="Dana Kaplan" />
              </Field>
              <Field label="Email" htmlFor="p-email" error="Use your school email address.">
                <Input id="p-email" defaultValue="dana@gmail" invalid />
              </Field>
              <Field label="Paper size" htmlFor="p-paper">
                <Select id="p-paper" defaultValue="letter">
                  <option value="letter">Letter</option>
                  <option value="a4">A4</option>
                </Select>
              </Field>
              <Field label="Disabled" htmlFor="p-dis">
                <Input id="p-dis" value="Only admins can change this" disabled readOnly />
              </Field>
            </div>
            <Field label="Allowed domains" hint="one per line" htmlFor="p-dom">
              <Textarea id="p-dom" rows={3} defaultValue={"lecfl.com\nstaff.lecfl.com"} />
            </Field>
            <SegmentedDemo />
            <div>
              <Checkbox label="Print on both sides" description="Saves paper on longer documents." defaultChecked />
              <Switch label="Email sign-in links" description="People get a one-time link by email." defaultChecked />
            </div>
          </CardBody>
          <CardFooter>
            <Button variant="ghost">Cancel</Button>
            <Button>Save changes</Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader title="Badges" />
          <div className="flex flex-wrap gap-2">
            <Badge>Neutral</Badge>
            <Badge tone="accent">Accent</Badge>
            <Badge tone="success">Online</Badge>
            <Badge tone="warning">3 to approve</Badge>
            <Badge tone="danger">Offline</Badge>
          </div>
        </Card>

        <div className="grid gap-4 sm:grid-cols-2">
          <EmptyState icon={Inbox} title="Nothing waiting" description="Jobs that need your approval will appear here." />
          <EmptyState
            icon={Users}
            title="No groups yet"
            description="Groups let you set print rules for a whole class or department."
            action={
              <Button size="sm">
                <Plus className="h-4 w-4" aria-hidden="true" />
                New group
              </Button>
            }
          />
        </div>

        <Card>
          <CardHeader title="Loading" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-10 w-full" />
          </div>
        </Card>
      </div>
    </main>
  );
}
