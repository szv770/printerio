import { redirect } from "next/navigation";
import { requirePlatformRole } from "@/lib/auth/session";
import { PlatformShell } from "./PlatformShell";
import { routes } from "@/lib/routes";

/**
 * Shell for the platform-level super-admin console - deliberately a sibling
 * of app/admin (not nested under it): /admin is scoped to one organization
 * (requireOrgRole), /platform operates across every organization in the
 * deployment (requirePlatformRole) and the two must never share a guard.
 * Visually mirrors app/admin/layout.tsx's nav shape on purpose so the two
 * consoles read as the same product.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  try {
    await requirePlatformRole();
  } catch {
    redirect(routes.start);
  }

  return <PlatformShell>{children}</PlatformShell>;
}
