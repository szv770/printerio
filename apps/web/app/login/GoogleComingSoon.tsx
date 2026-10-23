import { Button } from "@/components/ui";

/** Google sign-in is switched off for now: visible but greyed out. */
export function GoogleComingSoon() {
  return (
    <div>
      <Button type="button" variant="outline" disabled className="w-full" aria-describedby="google-soon">
        Sign in with Google
      </Button>
      <p id="google-soon" className="mt-1.5 text-center text-xs text-[var(--color-muted)]">
        Coming soon
      </p>
    </div>
  );
}
