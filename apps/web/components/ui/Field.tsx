import { Check } from "lucide-react";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

const FIELD_CLASSES = "block w-full rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm bg-[var(--color-surface)] text-[var(--color-text)]";

/** Wraps any form control with a consistent label - use around Input/Select/
 *  Textarea/a custom control, or standalone with `htmlFor`. */
export function FieldLabel({ children, htmlFor, hint }: { children: ReactNode; htmlFor?: string; hint?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-[var(--color-text)]">
      {children}
      {hint && <span className="ml-1 font-normal text-[var(--color-muted)]">{hint}</span>}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return <input {...rest} className={`${FIELD_CLASSES} ${className}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = "", ...rest } = props;
  return <select {...rest} className={`${FIELD_CLASSES} ${className}`} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = "", ...rest } = props;
  return <textarea {...rest} className={`${FIELD_CLASSES} font-mono ${className}`} />;
}

/** Consistent inline error text under a form - used with useActionState's
 *  error field throughout the app. Renders nothing if `message` is falsy, so
 *  it's safe to use unconditionally: `<FormError message={state.error} />`. */
export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return <p className="text-sm text-[var(--color-danger)]">{message}</p>;
}

/**
 * The positive counterpart to FormError, and used the same way:
 * `<FormSuccess message={state.success} />`.
 *
 * Several admin actions used to succeed completely silently - saving allowed
 * sign-in domains, changing a member's role, queueing a "Restart queue"
 * command - because the page's own rendered output doesn't visibly change
 * when they work. An admin clicking Save and seeing absolutely nothing happen
 * cannot tell success from a dead button, so every such action now returns a
 * one-line confirmation that says what actually happened.
 */
export function FormSuccess({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p className="flex items-start gap-1.5 text-sm text-[var(--color-success)]">
      <Check className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </p>
  );
}
