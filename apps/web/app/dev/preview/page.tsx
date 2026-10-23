import { notFound } from "next/navigation";
import { DevicesPreview, JobListPreview, JobPreview, PrintPreview, ProfilePreview, UsagePreview } from "./member-pages";
import { GroupsPreview, InvitesPreview, PrintersPreview, ServerDetailPreview, ServersPreview, UserDevicesPreview, UsersPreview } from "./admin-a";
import { ActivityPreview, AllJobsPreview, ApprovalsPreview, FilesPreview, LimitsPreview, ReportsPreview, RulesPreview } from "./admin-b";
import { JoinCard } from "@/app/join/JoinCard";
import { BookletPreviewSection } from "./booklet";
import { AdminHomeSection, TeacherHomeSection } from "./homes";
import {
  AdminSection,
  JobsSection,
  MemberSection,
  PrimitivesSection,
  SettingsSection,
} from "./sections";

/**
 * DEV-ONLY visual preview: every shell/page-chrome piece with hard-coded
 * sample data and no auth or database calls, so the UI can be looked at (and
 * screenshotted) without signing in. 404s everywhere except `next dev`.
 * Pick a section with ?section=admin|adminhome|teacher|member|settings|primitives|jobs|print|job|joblist|devices|usage|profile|users|groups|invites|printers|servers|serverdetail|userdevices|rules|limits|reports|activity|approvals|files|alljobs (+ &shell=admin, &variant=...).
 * Admin/member accept ?path=/admin/reports to pretend to be on that page.
 */
export default async function PreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ side?: string; section?: string; path?: string; shell?: string; variant?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();
  const { section = "admin", path, shell, variant, side } = await searchParams;
  switch (section) {
    case "join":
      return <JoinCard code="a1b2c3d4e5f6" orgName="Beth Rivkah" problem={variant} />;
    case "booklet":
      return <BookletPreviewSection side={side === "right" ? "right" : "left"} />;
    case "print":
      return <PrintPreview shell={shell} variant={variant} />;
    case "job":
      return <JobPreview shell={shell} variant={variant} />;
    case "joblist":
      return <JobListPreview shell={shell} />;
    case "devices":
      return <DevicesPreview shell={shell} variant={variant} />;
    case "usage":
      return <UsagePreview shell={shell} variant={variant} />;
    case "profile":
      return <ProfilePreview shell={shell} />;
    case "users":
      return <UsersPreview variant={variant} />;
    case "groups":
      return <GroupsPreview />;
    case "invites":
      return <InvitesPreview />;
    case "printers":
      return <PrintersPreview variant={variant} />;
    case "servers":
      return <ServersPreview />;
    case "serverdetail":
      return <ServerDetailPreview />;
    case "userdevices":
      return <UserDevicesPreview variant={variant} />;
    case "rules":
      return <RulesPreview variant={variant} />;
    case "limits":
      return <LimitsPreview variant={variant} />;
    case "reports":
      return <ReportsPreview variant={variant} />;
    case "activity":
      return <ActivityPreview variant={variant} />;
    case "approvals":
      return <ApprovalsPreview variant={variant} />;
    case "files":
      return <FilesPreview variant={variant} />;
    case "alljobs":
      return <AllJobsPreview variant={variant} />;
    case "adminhome":
      return <AdminHomeSection />;
    case "adminclear":
      return <AdminHomeSection variant="clear" />;
    case "adminsetup":
      return <AdminHomeSection variant="setup" />;
    case "teacher":
      return <TeacherHomeSection />;
    case "teachernoquota":
      return <TeacherHomeSection variant="noquota" />;
    case "teacherempty":
      return <TeacherHomeSection variant="empty" />;
    case "member":
      return <MemberSection path={path ?? "/jobs"} />;
    case "settings":
      return <SettingsSection />;
    case "primitives":
      return <PrimitivesSection />;
    case "jobs":
      return <JobsSection />;
    default:
      return <AdminSection path={path ?? "/admin"} />;
  }
}
