import Link from "next/link";
import type { ComponentProps, ButtonHTMLAttributes } from "react";
import { Spinner } from "./Spinner";

const VARIANT_CLASSES = {
  primary:
    "bg-[var(--color-primary)] text-[var(--color-primary-fg)] shadow-[inset_0_1px_0_rgb(255_255_255/0.16),var(--shadow-xs)] hover:bg-[var(--color-primary-hover)] active:bg-[var(--color-primary-hover)]",
  secondary:
    "border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-[var(--shadow-xs)] hover:border-[var(--color-faint)] hover:bg-[var(--color-surface-2)] active:bg-[var(--color-border)]",
  ghost: "text-[var(--color-text-2)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] active:bg-[var(--color-border)]",
  danger: "bg-[var(--color-danger)] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.14),var(--shadow-xs)] hover:brightness-90 active:brightness-85",
  // Existing names, kept so current pages are unchanged in meaning.
  success: "bg-[var(--color-success)] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.14),var(--shadow-xs)] hover:brightness-90 active:brightness-85",
  outline:
    "border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-[var(--shadow-xs)] hover:border-[var(--color-faint)] hover:bg-[var(--color-surface-2)] active:bg-[var(--color-border)]",
  "outline-danger":
    "border border-[var(--color-danger)]/60 bg-[var(--color-surface)] text-[var(--color-danger)] hover:border-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] active:bg-[var(--color-danger-soft)]",
} as const;

// Every size is at least 44px tall on touch screens; "sm" tightens on mouse pointers only.
const SIZE_CLASSES = {
  default: "min-h-11 px-4 text-sm rounded-[var(--radius-control)] [@media(pointer:fine)]:min-h-10",
  sm: "min-h-11 px-3 text-[13px] rounded-[var(--radius-control)] [@media(pointer:fine)]:min-h-8",
  lg: "min-h-12 px-5 text-base rounded-[var(--radius-control)]",
} as const;

const BASE_CLASSES =
  "inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap select-none transition-[background-color,border-color,box-shadow,filter,opacity] duration-150 focus-visible:outline-none focus-visible:shadow-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none aria-busy:cursor-progress [&_svg]:shrink-0 [&_svg:not([class*='h-'])]:h-4 [&_svg:not([class*='h-'])]:w-4";

/** Class string for anything that should look like a Button (e.g. a Link). */
export function buttonClass(variant: keyof typeof VARIANT_CLASSES = "primary", size: keyof typeof SIZE_CLASSES = "default", extra = "") {
  return `${BASE_CLASSES} ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${extra}`;
}

/** A navigation link styled as a Button. */
export function ButtonLink({
  variant = "primary",
  size = "default",
  className = "",
  ...props
}: ComponentProps<typeof Link> & { variant?: keyof typeof VARIANT_CLASSES; size?: keyof typeof SIZE_CLASSES }) {
  return <Link {...props} className={buttonClass(variant, size, className)} />;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANT_CLASSES;
  size?: keyof typeof SIZE_CLASSES;
  /** When true, disables the button, shows a spinner and swaps its label - the
   *  standard useActionState "Saving..." pattern. */
  pending?: boolean;
  pendingLabel?: string;
}

export function Button({
  variant = "primary",
  size = "default",
  pending = false,
  pendingLabel,
  disabled,
  children,
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={buttonClass(variant, size, className)}
    >
      {pending && <Spinner />}
      {pending ? (pendingLabel ?? "Working...") : children}
    </button>
  );
}
