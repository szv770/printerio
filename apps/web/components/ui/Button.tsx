import type { ButtonHTMLAttributes } from "react";

const VARIANT_CLASSES = {
  primary: "bg-[var(--color-primary)] text-[var(--color-primary-fg)] hover:opacity-90",
  success: "bg-[var(--color-success)] text-white hover:opacity-90",
  danger: "bg-[var(--color-danger)] text-white hover:opacity-90",
  outline: "border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface)]",
  "outline-danger": "border border-[var(--color-danger)] text-[var(--color-danger)] hover:bg-red-50",
  ghost: "text-[var(--color-primary)] hover:underline",
} as const;

const SIZE_CLASSES = {
  default: "px-4 py-3 text-base rounded-lg",
  sm: "px-3 py-1.5 text-xs rounded-lg",
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANT_CLASSES;
  size?: keyof typeof SIZE_CLASSES;
  /** When true, disables the button and swaps its label - the standard
   *  useActionState "Submitting..." pattern used throughout the admin/print
   *  forms, centralized so every form does it the same way. */
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
      className={`font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-60 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
    >
      {pending ? (pendingLabel ?? "Working...") : children}
    </button>
  );
}
