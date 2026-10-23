import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
import { lookupInvite } from "@/lib/auth/invite-lookup";
import { clientIpFrom } from "@/lib/auth/invite-rate-limit";
import { isPlausibleInviteCode } from "@/lib/auth/invite-link";
import { routes } from "@/lib/routes";
import { JoinCard } from "./JoinCard";

export default async function JoinPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  const session = await getCurrentSession();
  if (session?.membership) redirect(routes.home);
  // Already signed in but not in an organization: straight to the join step with the code filled in.
  if (session && isPlausibleInviteCode(code)) redirect(`${routes.noAccess}?code=${encodeURIComponent(code)}`);

  const invite = await lookupInvite(code, clientIpFrom(await headers()));
  return (
    <JoinCard
      code={code}
      orgName={"orgName" in invite ? invite.orgName : ""}
      problem={invite.state === "active" ? undefined : invite.state}
    />
  );
}
