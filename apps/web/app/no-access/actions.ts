"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { clientIpFrom } from "@/lib/auth/invite-rate-limit";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { redeemInvitation } from "@/lib/auth/invitations";
import { extractInviteCode } from "@/lib/auth/invite-link";
import { routes } from "@/lib/routes";

export interface RedeemState {
  error?: string;
}

export async function redeemInvitationAction(_prev: RedeemState, formData: FormData): Promise<RedeemState> {
  const raw = String(formData.get("code") ?? "").trim();
  if (!raw) return { error: "Paste your invite link or enrollment code." };
  const code = extractInviteCode(raw);
  if (!code) return { error: "That doesn't look like an invite link or code. Paste the whole link or the code." };

  const session = await requireSessionOrRedirect();
  const result = await redeemInvitation(code, session.userId, session.email, { ip: clientIpFrom(await headers()) });

  if (!result.ok) {
    const messages: Record<typeof result.reason, string> = {
      not_found: "That code isn't valid.",
      expired: "That code has expired.",
      exhausted: "That code has already been used the maximum number of times.",
      email_mismatch: "That invitation was issued to a different email address.",
      rate_limited: "Too many tries. Please wait a few minutes and try again.",
      already_member: "You're already a member of that organization.",
    };
    return { error: messages[result.reason] };
  }

  redirect(routes.start);
}
