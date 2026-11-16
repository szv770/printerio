import { requireSessionOrRedirect } from "@/lib/auth/session";
import { roleLabel } from "@/lib/role-label";
import { createClient } from "@/lib/supabase/server";
import { readPrintPreferences } from "@/lib/print-preferences";
import { ProfileView } from "./ProfileView";

export default async function ProfilePage() {
  const session = await requireSessionOrRedirect();
  const supabase = await createClient();
  const { data: org } = session.membership
    ? await supabase.from("organizations").select("name").eq("id", session.membership.organization_id).single()
    : { data: null };

  // The print-page setting. Never throws; when its table is not there yet (migration 0056 not applied) the checkbox is simply hidden.
  const preferences = await readPrintPreferences(supabase, session.userId);

  return (
    <ProfileView
      displayName={session.profile.display_name}
      email={session.email}
      orgName={org?.name ?? null}
      role={session.membership ? roleLabel(session.membership.role) : null}
      department={session.membership?.department ?? null}
      hasMembership={!!session.membership}
      printPreferences={preferences.available ? { rememberLast: preferences.rememberLast } : null}
    />
  );
}
