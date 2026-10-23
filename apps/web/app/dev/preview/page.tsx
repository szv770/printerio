import { notFound } from "next/navigation";
import { DevicesPreview, JobListPreview, JobPreview, PrintPreview, ProfilePreview, UsagePreview } from "./member-pages";
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
 * Pick a section with ?section=admin|adminhome|teacher|member|settings|primitives|jobs|print|job|joblist|devices|usage|profile (+ &shell=admin, &variant=...).
 * Admin/member accept ?path=/admin/reports to pretend to be on that page.
 */
export default async function PreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string; path?: string; shell?: string; variant?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();
  const { section = "admin", path, shell, variant } = await searchParams;
  switch (section) {
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
