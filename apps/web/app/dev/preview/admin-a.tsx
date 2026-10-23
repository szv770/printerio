import { AdminFrame } from "@/components/shell/AdminFrame";
import { PageHeader, Tabs } from "@/components/ui";
import type { Tables } from "@/lib/database.types";
import { peopleTabs, printerTabs } from "@/lib/admin/tabs";
import { describeAgentConnection, describeAgentVersion } from "@/lib/agent-detail";
import { UnmatchedSignups } from "@/app/admin/users/UnmatchedSignups";
import { MembersTable } from "@/app/admin/users/MembersTable";
import { InvitesPanel } from "@/app/admin/users/InvitesPanel";
import { GroupsPanel } from "@/app/admin/groups/GroupsPanel";
import { PrintersPanel } from "@/app/admin/printers/PrintersPanel";
import { AgentsPanel } from "@/app/admin/agents/AgentsPanel";
import { AgentDetail } from "@/app/admin/agents/[agentId]/AgentDetail";
import { UpdateBanner } from "@/app/admin/agents/[agentId]/UpdateBanner";
import { deriveUpdateView, type UpdateCommandRow } from "@/lib/update-progress";
import { DevicesAdmin, type AdminDevice } from "@/app/admin/devices/DevicesAdmin";

/** DEV-ONLY sample data for admin group A (people, printers, print servers, user devices). Nothing here touches auth or the database. */

const USER = { name: "Dana Kaplan", email: "dana@lecfl.com", roleLabel: "Admin" };
const NOW = Date.now();
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

function Frame({ path, children }: { path: string; children: React.ReactNode }) {
  return (
    <AdminFrame isOrgAdmin isSuperAdmin={false} userId="preview-user" pendingApprovals={2} user={USER} pathnameOverride={path}>
      {children}
    </AdminFrame>
  );
}

const MEMBERS = [
  { userId: "u1", displayName: "Dana Kaplan", email: "dana@lecfl.com", role: "org_admin", status: "active", department: "Office", userCode: "DK7", effectiveCode: "DK7" },
  { userId: "u2", displayName: "Moshe Levi", email: "moshe.levi@lecfl.com", role: "staff", status: "active", department: "Math", userCode: "ML2", effectiveCode: "ML2" },
  { userId: "u3", displayName: "Rivka Stein", email: "rivka@lecfl.com", role: "approver", status: "active", department: "Science", userCode: "RS9", effectiveCode: "RS9" },
  { userId: "u4", displayName: null, email: "substitute.teacher@lecfl.com", role: "student", status: "disabled", department: null, userCode: "ST4", effectiveCode: "ST4" },
  { userId: "u5", displayName: "Avi Goldman", email: "avi@lecfl.com", role: "staff", status: "active", department: "Art", userCode: "AG1", effectiveCode: "AG1" },
];

export function UsersPreview({ variant }: { variant?: string }) {
  return (
    <Frame path="/admin/users">
      <PageHeader title="Users" description="Everyone who can print here. Change a role, department or print code, then save." />
      <Tabs label="People" items={peopleTabs("users", true)} />
      <MembersTable members={variant === "empty" ? [] : MEMBERS} canEdit />
      <UnmatchedSignups
        signups={[
          { userId: "s1", email: "someone.long.address.for.wrapping@gmail.com", signedUpAt: "2026-10-22T10:00:00Z", lastSignInAt: "2026-10-22T10:05:00Z" },
          { userId: "s2", email: "kid@yahoo.com", signedUpAt: "2026-10-20T10:00:00Z", lastSignInAt: null },
        ]}
      />
    </Frame>
  );
}

export function GroupsPreview() {
  const groups = [
    { id: "g1", name: "Science department", kind: "department" },
    { id: "g2", name: "Grade 7", kind: "class" },
    { id: "g3", name: "Substitutes", kind: "custom" },
  ] as unknown as Tables<"groups">[];
  return (
    <Frame path="/admin/groups">
      <PageHeader title="Groups" description="Put people into departments or classes, so print rules and monthly limits can apply to the whole group." />
      <Tabs label="People" items={peopleTabs("groups", true)} />
      <GroupsPanel
        groups={groups}
        groupMembers={[
          { group_id: "g1", user_id: "u3" },
          { group_id: "g1", user_id: "u2" },
          { group_id: "g2", user_id: "u5" },
        ]}
        roster={MEMBERS.map((m) => ({ userId: m.userId, label: m.displayName ?? m.email }))}
        canManage
      />
    </Frame>
  );
}

export function InvitesPreview() {
  return (
    <Frame path="/admin/invites">
      <PageHeader title="Invites" description="Invite someone with a link. Turn an invite off any time." />
      <Tabs label="People" items={peopleTabs("invites", true)} />
      <InvitesPanel
        invitations={[
          { id: "i1", code: "a1b2c3d4e5f6", role: "staff", groupName: "Grade 5 teachers", usesCount: 3, maxUses: 10, expiresAt: ago(-60 * 24 * 14) },
          { id: "i2", code: "9f8e7d6c5b4a", role: "student", usesCount: 0, maxUses: null, expiresAt: null },
          { id: "i3", code: "00aa11bb22cc", role: "student", usesCount: 1, maxUses: 1, expiresAt: null },
          { id: "i4", code: "ffeedd998877", role: "staff", usesCount: 0, maxUses: null, expiresAt: ago(60 * 24 * 2) },
        ]}
        orgName="Beth Rivkah"
        groups={[{ id: "g1", name: "Grade 5 teachers" }, { id: "g2", name: "Office" }]}
      />
    </Frame>
  );
}

const PRINTERS = [
  { id: "p1", name: "Main office Kyocera", vendor: "Kyocera", model: "TASKalfa MZ8500i", location: "Front office", status: "online", last_status_at: ago(2) },
  { id: "p2", name: "Library printer", vendor: "HP", model: "LaserJet M455", location: "Library", status: "error", last_status_at: ago(35) },
  { id: "p3", name: "Teachers room", vendor: "Brother", model: "HL-L8360", location: "Second floor", status: "offline", last_status_at: null },
] as unknown as Tables<"printers">[];

const CAPS = { duplex: true, color: true, staple: true, booklet: true, punch: false };
const PROFILES = [
  { id: "pp1", printer_id: "p1", agent_id: "a1", key: "std", label: "Everyday, double-sided", description: "Black and white, double-sided", icon_key: null, output_mode: "queue", windows_queue_name: "Kyocera_Main_Std", raw_host: null, raw_port: null, raw_staple_position: null, declared_paper_sizes: ["letter", "11x17"], declared_capabilities: CAPS, booklet_binding_side: "left", is_default: true },
  { id: "pp2", printer_id: "p1", agent_id: "a1", key: "booklet", label: "Booklet with staples", description: null, icon_key: null, output_mode: "raw", windows_queue_name: null, raw_host: "192.168.1.50", raw_port: 9100, raw_staple_position: "top-left", declared_paper_sizes: ["11x17"], declared_capabilities: CAPS, booklet_binding_side: "left", is_default: false },
  { id: "pp3", printer_id: "p2", agent_id: "a2", key: "lib", label: "Library black and white", description: null, icon_key: null, output_mode: "queue", windows_queue_name: "HP_Library", raw_host: null, raw_port: null, raw_staple_position: null, declared_paper_sizes: ["letter"], declared_capabilities: { ...CAPS, staple: false, booklet: false }, booklet_binding_side: "left", is_default: false },
] as unknown as Tables<"printer_profiles">[];

const AGENTS = [
  { id: "a1", name: "MLM Office", last_seen_at: ago(1), paused: false },
  { id: "a2", name: "Library PC", last_seen_at: ago(90), paused: false },
];

export function PrintersPreview({ variant }: { variant?: string }) {
  return (
    <Frame path="/admin/printers">
      <PageHeader title="Printers" description="Your printers and the print queues people can send jobs to." />
      <Tabs label="Printers and devices" items={printerTabs("printers", true)} />
      <PrintersPanel
        printers={variant === "empty" ? [] : PRINTERS}
        profiles={PROFILES}
        agents={AGENTS}
        canManage
        defaultBookletBindingSide="left"
      />
    </Frame>
  );
}

function agent(over: Record<string, unknown>) {
  return {
    id: "a1",
    name: "MLM Office",
    status: "active",
    paused: false,
    paused_at: null,
    paused_by: null,
    hostname: "MLM-OFFICE-PC",
    os_version: "Windows 11 Pro",
    ip_addresses: ["192.168.1.20"],
    is_git_checkout: true,
    version: "0.2.0",
    last_seen_at: ago(1),
    enrollment_code: null,
    enrollment_code_expires_at: null,
    ...over,
  } as unknown as Tables<"agents">;
}

export function ServersPreview() {
  return (
    <Frame path="/admin/agents">
      <PageHeader title="Print servers" description="The Windows computers that send approved jobs to your printers." />
      <Tabs label="Printers and devices" items={printerTabs("agents", true)} />
      <AgentsPanel
        agents={[
          agent({}),
          agent({ id: "a2", name: "Library PC", hostname: "LIB-PC", last_seen_at: ago(90) }),
          agent({ id: "a3", name: "Gym PC", status: "pending", hostname: null, version: null, last_seen_at: null, enrollment_code: "K7M2-QX9P", enrollment_code_expires_at: ago(-600) }),
        ]}
        canManage
      />
    </Frame>
  );
}

/** The update-banner states, as the command rows the page would really have. Minutes ago, like `ago`. */
function updateRows(variant: string | undefined): { commands: UpdateCommandRow[]; lastSeenAt: string } {
  const row = (o: Partial<UpdateCommandRow>): UpdateCommandRow => ({ id: "u1", command: "CHECK_FOR_UPDATE", status: "completed", createdAt: ago(3), completedAt: ago(3), result: null, checkOnly: false, ...o });
  const seen = ago(0.2);
  switch (variant) {
    case "checking":
      return { commands: [row({ status: "pending", completedAt: null, createdAt: ago(0.1), checkOnly: true })], lastSeenAt: seen };
    case "available":
      return { commands: [row({ checkOnly: true, createdAt: ago(1), completedAt: ago(0.9), result: { mode: "check_only", updateAvailable: true, latest: "8c4d0e2", latestMessage: "Booklets print faster and the dashboard loads sooner", behind: 3, current: "3f2a1b9" } })], lastSeenAt: seen };
    case "downloading":
      return { commands: [row({ status: "acknowledged", completedAt: null, createdAt: ago(0.4), result: { step: "downloading", message: "Downloading the update..." } })], lastSeenAt: seen };
    case "installing":
      return { commands: [row({ status: "acknowledged", completedAt: null, createdAt: ago(1), result: { step: "installing", message: "Installing the update..." } })], lastSeenAt: seen };
    case "restarting":
      return { commands: [row({ createdAt: ago(1.5), completedAt: ago(0.3), result: { updated: true, reason: "updated", from: "3f2a1b9", to: "8c4d0e2", step: "restarting" } })], lastSeenAt: ago(0.6) };
    case "done":
      return { commands: [row({ createdAt: ago(2.5), completedAt: ago(1.5), result: { updated: true, reason: "updated", from: "3f2a1b9", to: "8c4d0e2", step: "restarting" } })], lastSeenAt: ago(0.2) };
    case "failed":
      return { commands: [row({ createdAt: ago(2), completedAt: ago(1), result: { updated: false, reason: "install_failed", step: "installing", message: "New code was downloaded, but installing its packages failed, so the print server was NOT restarted and is still running the previous version. Nothing was lost." } })], lastSeenAt: seen };
    case "check_failed":
      return { commands: [row({ checkOnly: true, createdAt: ago(1), completedAt: ago(0.9), result: { mode: "check_only", updateAvailable: false, reason: "git_failed", message: "Could not reach GitHub to look for updates." } })], lastSeenAt: seen };
    case "legacy_stale":
      // Version 0.1.0 agent; the only row is an old "already up to date" from the legacy full-update flow.
      return { commands: [row({ createdAt: ago(7200), completedAt: ago(7190), result: { updated: false, reason: "already_up_to_date", message: "Already up to date - this Agent is running the latest code in its checkout." } })], lastSeenAt: seen };
    default:
      return { commands: [row({ checkOnly: true, createdAt: ago(3), completedAt: ago(2.9), result: { mode: "check_only", updateAvailable: false, reason: "up_to_date", current: "8c4d0e2" } })], lastSeenAt: seen };
  }
}

const BANNER_VARIANTS = ["checking", "available", "uptodate", "legacy_stale", "legacy_none", "downloading", "installing", "restarting", "done", "failed", "check_failed"] as const;

/** Every banner state stacked, for looking at them side by side (?section=updatebanner). */
export function UpdateBannerPreview() {
  return (
    <Frame path="/admin/agents/a1">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {BANNER_VARIANTS.map((v) => {
          const { commands, lastSeenAt } = updateRows(v === "legacy_none" ? "legacy_stale" : v);
          const legacy = v === "legacy_stale" || v === "legacy_none";
          return (
            <div key={v}>
              <p className="mb-1 font-mono text-xs text-[var(--color-muted)]">{v}</p>
              <UpdateBanner
                view={deriveUpdateView({ commands: v === "legacy_none" ? [] : commands, lastSeenAt, nowMs: NOW, agentVersion: legacy ? "0.1.0" : "0.2.0", latestVersion: "0.2.0" })}
                canCheckAgain={!legacy}
                elapsedNow={NOW}
              />
            </div>
          );
        })}
        <div>
          <p className="mb-1 font-mono text-xs text-[var(--color-muted)]">offline</p>
          <UpdateBanner view={{ kind: "idle" }} situation="offline" />
        </div>
        <div>
          <p className="mb-1 font-mono text-xs text-[var(--color-muted)]">cannot_update</p>
          <UpdateBanner view={{ kind: "idle" }} situation="cannot_update" />
        </div>
      </div>
    </Frame>
  );
}

export function ServerDetailPreview({ variant }: { variant?: string } = {}) {
  const { commands, lastSeenAt } = updateRows(variant);
  const a = agent({ last_seen_at: lastSeenAt, ...(variant === "legacy" || variant === "legacy_stale" ? { version: "0.1.0" } : {}) });
  return (
    <Frame path="/admin/agents/a1">
      <div className="mx-auto max-w-3xl">
        <PageHeader title={a.name} description="MLM-OFFICE-PC, Checked in within the last 5 minutes and is taking print jobs." />
        <AgentDetail
          agent={a}
          connection={describeAgentConnection(a, NOW)}
          version={describeAgentVersion(a.version)}
          activity={{ lastSyncedAt: ago(1), lastJobActivityAt: ago(34), lastCommandAt: ago(300) }}
          pausedByLabel={null}
          queues={[
            { id: "pp1", label: "Everyday, double-sided", windowsQueueName: "Kyocera_Main_Std", printerId: "p1", printerName: "Main office Kyocera", printerStatus: "online", printerStatusAt: ago(2), usage: { totalJobs: 412, printedJobs: 405, lastUsedAt: ago(34) } },
            { id: "pp2", label: "Booklet with staples", windowsQueueName: null, rawTarget: "192.168.1.50:9100", printerId: "p1", printerName: "Main office Kyocera", printerStatus: "online", printerStatusAt: ago(2), usage: { totalJobs: 0, printedJobs: 0, lastUsedAt: null } },
          ]}
          recentCommands={[
            ...commands,
            { id: "c2", command: "RESTART_SERVICE", status: "failed", createdAt: ago(900), completedAt: ago(899), result: null, checkOnly: false },
          ]}
          nowMs={NOW}
          canManage
        />
      </div>
    </Frame>
  );
}

const DEVICES: AdminDevice[] = [
  { id: "d1", userName: "Moshe Levi", name: "Pixel 8", device_type: "android", created_at: ago(2000), revoked_at: null, last_seen_at: ago(20), first_job_at: ago(100), first_printed_at: null, last_user_agent: "Android 14", stuck: "job_not_printed", issues: [{ id: "x1", kind: "nothing_prints", note: "I press print and nothing comes out.", status: "open", created_at: ago(60), resolved_note: null, resolved_at: null }] },
  { id: "d2", userName: "Rivka Stein", name: "School Chromebook", device_type: "chromebook", created_at: ago(5000), revoked_at: null, last_seen_at: ago(30), first_job_at: null, first_printed_at: null, last_user_agent: null, stuck: "connected_no_job", issues: [] },
  { id: "d3", userName: "Dana Kaplan", name: "Work laptop", device_type: "windows", created_at: ago(9000), revoked_at: null, last_seen_at: ago(120), first_job_at: ago(8000), first_printed_at: ago(7990), last_user_agent: null, stuck: null, issues: [] },
  { id: "d4", userName: "Avi Goldman", name: "Old iPad", device_type: "iphone", created_at: ago(20000), revoked_at: ago(1000), last_seen_at: ago(1500), first_job_at: ago(19000), first_printed_at: ago(18990), last_user_agent: null, stuck: null, issues: [] },
];

export function UserDevicesPreview({ variant }: { variant?: string }) {
  return (
    <Frame path="/admin/devices">
      <PageHeader
        title="All devices"
        description="Phones and laptops people print from. The ones that need a look are at the top."
        action={<span className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-3 text-sm font-medium text-white">+ Add device</span>}
      />
      <Tabs label="Printers and devices" items={printerTabs("devices", true)} />
      <DevicesAdmin devices={variant === "empty" ? [] : DEVICES} />
    </Frame>
  );
}
