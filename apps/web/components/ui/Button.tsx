import Link from "next/link";
import type { ComponentProps, ButtonHTMLAttributes } from "react";
import { Spinner } from "./Spinner";

const VARIANT_CLASSES = {
  primary:
    "bg-[var(--color-primary)] text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] hover:bg-[var(--color-primary-hover)]",
  secondary:
    "border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-[var(--shadow-xs)] hover:bg-[var(--color-surface-2)]",
  ghost: "text-[var(--color-text-2)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]",
  danger: "bg-[var(--color-danger)] text-white shadow-[var(--shadow-xs)] hover:brightness-90",
  // Existing names, kept so current pages are unchanged in meaning.
  success: "bg-[var(--color-success)] text-white shadow-[var(--shadow-xs)] hover:brightness-90",
  outline:
    "border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]",
  "outline-danger":
    "border border-[var(--color-danger)] bg-[var(--color-surface)] text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]",
} as const;

// Every size is at least 44px tall on touch screens; "sm" tightens on mouse pointers only.
const SIZE_CLASSES = {
  default: "min-h-11 px-4 text-sm rounded-[var(--radius-control)]",
  sm: "min-h-11 px-3 text-[13px] rounded-[var(--radius-control)] [@media(pointer:fine)]:min-h-9",
  lg: "min-h-12 px-5 text-base rounded-[var(--radius-control)]",
} as const;

const BASE_CLASSES =
  "inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap transition-[background-color,box-shadow,filter,opacity] duration-150 focus-visible:outline-none focus-visible:shadow-[var(--ring)] active:brightness-95 disabled:cursor-not-allowed disabled:opacity-55 disabled:shadow-none";

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
