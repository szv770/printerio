import { routes } from "@/lib/routes";

/** Where Google (via Supabase) sends the browser back to. The callback route exchanges the code and runs finishSignIn. */
export function googleRedirectTo(origin: string, inviteCode?: string): string {
  return `${origin}${routes.authCallback}${inviteCode ? `?invite=${encodeURIComponent(inviteCode)}` : ""}`;
}

export function googleErrorMessage(raw: string): string {
  if (/provider is not enabled|unsupported provider/i.test(raw)) {
    return "Google sign-in isn't switched on yet. Use your email instead.";
  }
  return "Google sign-in didn't start. Try again, or use your email instead.";
}

/** The Google button only works once the Google provider is enabled in Supabase; until then it stays "coming soon". */
export function googleSignInEnabled(flag: string | undefined): boolean {
  return flag === "1";
}
