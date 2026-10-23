import { IdCard } from "lucide-react";
import { Card, Collapsible, PageHeader } from "@/components/ui";
import { ProfileForm } from "./ProfileForm";

/** The profile page body. Presentational (no data access) so the dev preview can render it with sample data. */
export function ProfileView({
  displayName,
  email,
  orgName,
  role,
  department,
  hasMembership,
}: {
  displayName: string | null;
  email: string;
  orgName: string | null;
  role: string | null;
  department: string | null;
  hasMembership: boolean;
}) {
  const shownName = displayName?.trim() || email;
  const initial = shownName.trim().charAt(0).toUpperCase() || "?";
  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
      <PageHeader title="Profile" />
      <div className="flex flex-col gap-3">
        <Card className="flex flex-col gap-5 sm:p-6">
          <div className="flex items-center gap-4">
            <span
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-2xl font-semibold text-[var(--color-primary-fg)] shadow-[var(--shadow-card)]"
              aria-hidden="true"
            >
              {initial}
            </span>
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold leading-6">{shownName}</p>
              <p className="truncate text-sm text-[var(--color-muted)]">{email}</p>
            </div>
          </div>
          <ProfileForm displayName={displayName} />
        </Card>

        {hasMembership && (
          <Collapsible
            id="profile-account"
            title="Account details"
            icon={<IdCard className="h-4 w-4" aria-hidden="true" />}
            summary={[orgName, role].filter(Boolean).join(" · ")}
          >
            <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
              <div>
                <dt className="text-[13px] text-[var(--color-muted)]">Email</dt>
                <dd className="mt-0.5 break-all font-medium">{email}</dd>
              </div>
              <div>
                <dt className="text-[13px] text-[var(--color-muted)]">Organization</dt>
                <dd className="mt-0.5 font-medium">{orgName ?? "-"}</dd>
              </div>
              <div>
                <dt className="text-[13px] text-[var(--color-muted)]">Role</dt>
                <dd className="mt-0.5 font-medium">{role}</dd>
              </div>
              {department && (
                <div>
                  <dt className="text-[13px] text-[var(--color-muted)]">Department</dt>
                  <dd className="mt-0.5 font-medium">{department}</dd>
                </div>
              )}
            </dl>
          </Collapsible>
        )}
      </div>
    </main>
  );
}
