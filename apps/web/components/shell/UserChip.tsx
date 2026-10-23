import { LogOut } from "lucide-react";
import { signOutAction } from "@/lib/auth/actions";
import { avatarInitial } from "@/lib/nav";

export interface ShellUser {
  name: string | null;
  email: string;
  roleLabel: string;
}

/** Avatar initial + name + role, with a quiet sign-out button. */
export function UserChip({ user }: { user: ShellUser }) {
  return (
    <div className="flex items-center gap-2.5 rounded-[var(--radius-control)] p-1.5">
      <span
        aria-hidden="true"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-soft)] text-sm font-semibold text-[var(--color-primary)]"
      >
        {avatarInitial(user.name, user.email)}
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[13px] font-medium text-[var(--color-text)]">{user.name || user.email}</span>
        <span className="block truncate text-xs text-[var(--color-muted)]">{user.roleLabel}</span>
      </span>
      <form action={signOutAction}>
        <button
          type="submit"
          title="Sign out"
          aria-label="Sign out"
          className="flex h-11 w-11 items-center justify-center rounded-lg text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] md:h-9 md:w-9"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}
