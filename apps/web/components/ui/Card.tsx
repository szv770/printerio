import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 ${className}`}>
      {children}
    </div>
  );
}
