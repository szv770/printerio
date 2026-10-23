import { notFound } from "next/navigation";
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
 * Pick a section with ?section=admin|adminhome|teacher|member|settings|primitives|jobs.
 * Admin/member accept ?path=/admin/reports to pretend to be on that page.
 */
export default async function PreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string; path?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();
  const { section = "admin", path } = await searchParams;
  switch (section) {
    case "adminhome":
      return <AdminHomeSection />;
    case "teacher":
      return <TeacherHomeSection />;
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
