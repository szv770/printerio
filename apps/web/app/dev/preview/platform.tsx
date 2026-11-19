import { PlatformShell } from "@/app/platform/PlatformShell";
import { PlatformOverviewView } from "@/app/platform/OverviewView";
import PlatformLoading from "@/app/platform/loading";
import { PageHeader } from "@/components/ui";
import { CreateOrganizationForm } from "@/app/platform/organizations/new/CreateOrganizationForm";
import { SuperAdminsPanel } from "@/app/platform/super-admins/SuperAdminsPanel";
import { summarizeDeploymentTotals, type OrganizationSummary } from "@/lib/platform/overview";

/** DEV-ONLY sample data for the platform console. Nothing here touches auth or the database. */
const ORGS: OrganizationSummary[] = [
  { id: "o1", name: "Beth Rivkah Academy", slug: "beth-rivkah", memberCount: 142, printerCount: 6, agentCount: 2, agentsOnline: 2, jobsLast30d: 4210 },
  { id: "o2", name: "Lincoln Elementary School of the Valley", slug: "lincoln-elementary-of-the-valley", memberCount: 38, printerCount: 2, agentCount: 1, agentsOnline: 0, jobsLast30d: 312 },
  { id: "o3", name: "Demo", slug: "demo", memberCount: 3, printerCount: 0, agentCount: 0, agentsOnline: 0, jobsLast30d: 0 },
];

export function PlatformPreview({ variant }: { variant?: string }) {
  let content: React.ReactNode;
  if (variant === "loading") {
    content = <PlatformLoading />;
  } else if (variant === "new") {
    content = (
      <div>
        <PageHeader
          title="Create organization"
          description="Creates the organization and its default settings. Add a first admin afterward from the Overview page (Join as admin) or by inviting them once they have a membership."
        />
        <CreateOrganizationForm />
      </div>
    );
  } else if (variant === "admins") {
    content = (
      <div>
        <PageHeader
          title="Super admins"
          description="Platform-level access only - a super admin has no implicit access to any organization's print jobs or files until they explicitly join it (see Overview - Join as admin), which is itself recorded in the activity log."
        />
        <SuperAdminsPanel
          currentUserId="s1"
          superAdmins={[
            { userId: "s1", email: "owner@printio.example", displayName: "Owner" },
            { userId: "s2", email: "second.super.admin.with.a.long.address@example.com", displayName: null },
          ]}
        />
      </div>
    );
  } else {
    const summaries = variant === "empty" ? [] : ORGS;
    content = (
      <PlatformOverviewView
        summaries={summaries}
        totals={summarizeDeploymentTotals(summaries)}
        ownMembershipByOrg={new Map([["o1", "org_admin"]])}
      />
    );
  }
  return <PlatformShell>{content}</PlatformShell>;
}
