import { Check, AlertCircle } from "lucide-react";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

const FIELD_CLASSES =
  "block w-full min-h-11 rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-3 py-2 text-[var(--color-text)] shadow-[var(--shadow-xs)] placeholder:text-[var(--color-faint)] transition-[border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:shadow-[var(--ring)] disabled:cursor-not-allowed disabled:bg-[var(--color-surface-2)] disabled:text-[var(--color-muted)] [@media(pointer:fine)]:min-h-10";

function borderFor(invalid?: boolean) {
  return invalid ? "border-[var(--color-danger)]" : "border-[var(--color-border-strong)] hover:border-[var(--color-faint)]";
}

/** Wraps any form control with a consistent label - use around Input/Select/
 *  Textarea/a custom control, or standalone with `htmlFor`. */
export function FieldLabel({ children, htmlFor, hint }: { children: ReactNode; htmlFor?: string; hint?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-medium leading-5 text-[var(--color-text)]">
      {children}
      {hint && <span className="ml-1.5 font-normal text-[var(--color-muted)]">{hint}</span>}
    </label>
  );
}

type InvalidProp = { invalid?: boolean };

export function Input(props: InputHTMLAttributes<HTMLInputElement> & InvalidProp) {
  const { className = "", invalid, ...rest } = props;
  return <input aria-invalid={invalid || undefined} {...rest} className={`${FIELD_CLASSES} ${borderFor(invalid)} ${className}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement> & InvalidProp) {
  const { className = "", invalid, ...rest } = props;
  return <select aria-invalid={invalid || undefined} {...rest} className={`${FIELD_CLASSES} ${borderFor(invalid)} ${className}`} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & InvalidProp) {
  const { className = "", invalid, ...rest } = props;
  return (
    <textarea
      aria-invalid={invalid || undefined}
      {...rest}
      className={`${FIELD_CLASSES} font-mono text-sm ${borderFor(invalid)} ${className}`}
    />
  );
}

/** Label + control + helper text + inline error as one unit. Pass the control's
 *  `id` as `htmlFor`; give the control `aria-describedby={`${htmlFor}-desc`}`
 *  to have the helper/error read out with it. */
export function Field({
  label,
  htmlFor,
  hint,
  help,
  error,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: string;
  help?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div>
      <FieldLabel htmlFor={htmlFor} hint={hint}>
        {label}
      </FieldLabel>
      {children}
      <div id={`${htmlFor}-desc`}>
        {error ? <FieldError message={error} /> : help ? <p className="mt-1.5 text-[13px] text-[var(--color-muted)]">{help}</p> : null}
      </div>
    </div>
  );
}

/** Inline error placed directly under the field it belongs to. */
export function FieldError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1.5 flex items-start gap-1.5 text-[13px] text-[var(--color-danger)]">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </p>
  );
}

/** Checkbox with a full-width 44px tap row, label and optional description. */
export function Checkbox({
  label,
  description,
  className = "",
  ...rest
}: { label: ReactNode; description?: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <label className={`flex min-h-11 cursor-pointer items-start gap-3 py-2 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 ${className}`}>
      <input
        {...rest}
        type="checkbox"
        className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded-md border-[var(--color-border-strong)] accent-[var(--color-primary)] disabled:cursor-not-allowed"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium leading-5 text-[var(--color-text)]">{label}</span>
        {description && <span className="mt-0.5 block text-[13px] text-[var(--color-muted)]">{description}</span>}
      </span>
    </label>
  );
}

/** On/off switch built on a real checkbox (role="switch"), so forms and
 *  keyboard behave natively. Label on the left, switch on the right. */
export function Switch({
  label,
  description,
  className = "",
  ...rest
}: { label: ReactNode; description?: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role">) {
  return (
    <label className={`flex min-h-11 cursor-pointer items-start justify-between gap-4 py-2 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 ${className}`}>
      <span className="min-w-0">
        <span className="block text-sm font-medium leading-6 text-[var(--color-text)]">{label}</span>
        {description && <span className="mt-0.5 block text-[13px] text-[var(--color-muted)]">{description}</span>}
      </span>
      <span className="relative mt-0.5 inline-flex h-6 w-11 shrink-0">
        <input {...rest} type="checkbox" role="switch" className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" />
        <span className="absolute inset-0 rounded-full bg-[var(--color-border-strong)] transition-colors duration-150 peer-checked:bg-[var(--color-primary)] peer-focus-visible:shadow-[var(--ring)]" />
        <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-[var(--shadow-card)] transition-transform duration-150 motion-reduce:transition-none peer-checked:translate-x-5" />
      </span>
    </label>
  );
}

/** Consistent inline error text under a form - used with useActionState's
 *  error field throughout the app. Renders nothing if `message` is falsy, so
 *  it's safe to use unconditionally: `<FormError message={state.error} />`. */
export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-start gap-1.5 text-sm text-[var(--color-danger)]">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </p>
  );
}

/**
 * The positive counterpart to FormError, and used the same way:
 * `<FormSuccess message={state.success} />`. Every action that would otherwise
 * succeed silently returns a one-line confirmation saying what happened.
 */
export function FormSuccess({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="status" className="flex items-start gap-1.5 text-sm text-[var(--color-success)]">
      <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </p>
  );
}
