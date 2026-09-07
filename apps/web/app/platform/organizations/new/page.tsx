import { requirePlatformRole } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui";
import { CreateOrganizationForm } from "./CreateOrganizationForm";

export default async function NewOrganizationPage() {
  await requirePlatformRole();

  return (
    <div>
      <PageHeader
        title="Create organization"
        description="Creates the organization and its default settings. Add a first admin afterward from the Overview page (Join as admin) or by inviting them once they have a membership."
      />
      <CreateOrganizationForm />
    </div>
  );
}
