export function EmptyState({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-muted)]">
      {message}
    </p>
  );
}
