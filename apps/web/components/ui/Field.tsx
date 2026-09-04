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
