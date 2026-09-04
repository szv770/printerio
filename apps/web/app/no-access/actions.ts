"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import { redeemInvitation } from "@/lib/auth/invitations";
import { routes } from "@/lib/routes";

export interface RedeemState {
  error?: string;
}

export async function redeemInvitationAction(_prev: RedeemState, formData: FormData): Promise<RedeemState> {
  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { error: "Enter an enrollment code." };

  const session = await requireSession();
  const result = await redeemInvitation(code, session.userId, session.email);

  if (!result.ok) {
    const messages: Record<typeof result.reason, string> = {
      not_found: "That code isn't valid.",
      expired: "That code has expired.",
      exhausted: "That code has already been used the maximum number of times.",
      email_mismatch: "That invitation was issued to a different email address.",
      already_member: "You're already a member of that organization.",
    };
    return { error: messages[result.reason] };
  }

  redirect(routes.home);
}
