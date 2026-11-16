"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { describeDatabaseError } from "@/lib/action-errors";
import { routes } from "@/lib/routes";
import { saveRememberLast } from "@/lib/print-preferences";

export interface ProfileActionState {
  error?: string;
  saved?: boolean;
}

export async function updateDisplayNameAction(_prev: ProfileActionState, formData: FormData): Promise<ProfileActionState> {
  const session = await requireSessionOrRedirect();
  const displayName = String(formData.get("displayName") ?? "").trim();
  if (!displayName) return { error: "Name cannot be empty." };
  if (displayName.length > 200) return { error: "Name is too long." };

  const supabase = await createClient();
  const { error } = await supabase.from("profiles").update({ display_name: displayName }).eq("id", session.userId);
  if (error) return { error: describeDatabaseError(error, "Couldn't save your name.") };

  revalidatePath(routes.profile);
  return { saved: true };
}

/** "Remember my last print choices": a plain checkbox, saved for the signed-in person only (their own row, via their own session). */
export async function updateRememberLastAction(_prev: ProfileActionState, formData: FormData): Promise<ProfileActionState> {
  const session = await requireSessionOrRedirect();
  const supabase = await createClient();
  const ok = await saveRememberLast(supabase, session.userId, formData.get("rememberLast") === "on");
  if (!ok) return { error: "Couldn't save that setting. Try again in a moment." };
  revalidatePath(routes.profile);
  return { saved: true };
}
