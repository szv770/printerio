"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";

/** Shared by every layout (dashboard + admin) - there was previously no way
 *  to sign out of the app at all. */
export async function signOutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect(routes.login);
}
