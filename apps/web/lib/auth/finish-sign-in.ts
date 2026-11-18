import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { maybeBootstrapOrganization } from "@/lib/auth/bootstrap";
import { tryJoinByDomain, hasActiveMembership } from "@/lib/auth/domain-join";
import { routes } from "@/lib/routes";
import { logger } from "@/lib/logger";
import { redeemInvitation } from "@/lib/auth/invitations";

export type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;
export type SessionUser = NonNullable<
  Awaited<ReturnType<SupabaseServerClient["auth"]["exchangeCodeForSession"]>>["data"]["user"]
>;

/** Post-login steps shared by BOTH entry paths (code exchange and token-hash
 *  verification): bootstrap, reauth stamp, invite, join rule, redirect. */
export async function finishSignIn(
  user: SessionUser,
  email: string,
  origin: string,
  invite?: { code: string; ip: string },
): Promise<NextResponse> {
  const userId = user.id;

  try {
    await maybeBootstrapOrganization(userId, email);
  } catch (bootstrapError) {
    // Never fail sign-in over a bootstrap hiccup - log and continue; the
    // user lands on the "no access yet" screen instead of a hard error.
    logger.error("organization bootstrap failed", {
      userId,
      error: bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError),
    });
  }

  // Stamp the reauth clock for every completed interactive sign-in (see
  // lib/auth/reauth.ts). A person without membership has zero access anyway;
  // without the stamp the "You need an invite" page would bounce them to login.
  //
  // Must go through the service-role client, not the ordinary
  // session-scoped `supabase` used above for exchangeCodeForSession:
  // supabase/migrations/0016_protect_last_authenticated_at.sql adds a
  // trigger that rejects any change to this column from a caller whose
  // role isn't service_role (closing a real hole where any authenticated
  // client could otherwise re-stamp its own row and defeat the 30-day
  // reauth control entirely - see that migration's own comment). Using
  // the ordinary client here would have every legitimate sign-in's
  // update silently rejected by that same trigger, which is exactly the
  // bug this comment is warning against re-introducing.
  const { error: touchError } = await createServiceRoleClient()
    .from("profiles")
    .update({ last_authenticated_at: new Date().toISOString() })
    .eq("id", userId);
  if (touchError) {
    logger.error("failed to stamp last_authenticated_at", { userId, error: touchError.message });
  }

  // Invite link (/join?code=...): the code travelled through the emailed
  // link (or a cookie set on the join page), so the person never types it.
  // Redeemed BEFORE any domain rule: an invited outsider must get in.
  if (invite) {
    const result = await redeemInvitation(invite.code, userId, email, { ip: invite.ip });
    if (!result.ok && result.reason !== "already_member") {
      const url = new URL(`${origin}${routes.noAccess}`);
      url.searchParams.set("code", invite.code);
      url.searchParams.set("invite_error", result.reason);
      return NextResponse.redirect(url);
    }
  }

  // "Who can join" (security review F4, migration 0039). Membership comes only
  // from an invitation (above) or, if an admin chose "invite or allowed email
  // domain", from join_org_by_domain() in Postgres, which re-checks the VERIFIED
  // email itself. Everyone else stays signed in with zero access and lands on
  // the friendly "You need an invite" page (no error, nothing to retry).
  if (!(await hasActiveMembership(userId))) {
    await tryJoinByDomain(userId);
    if (!(await hasActiveMembership(userId))) {
      const url = new URL(`${origin}${routes.noAccess}`);
      url.searchParams.set("reason", "invite_needed");
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.redirect(`${origin}${routes.start}`);
}
