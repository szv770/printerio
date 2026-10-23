import Link from "next/link";
import type { ReactNode } from "react";

export interface PillItem {
  href: string;
  label: string;
  active?: boolean;
  badge?: ReactNode;
}

/**
 * Filter pills: a row of rounded links (each one is a page address, so they
 * work without JavaScript and can be bookmarked). Scrolls sideways on narrow
 * screens instead of wrapping; every pill is a 44px tap target.
 */
export function Pills({ items, label }: { items: PillItem[]; label: string }) {
  return (
    <nav
      aria-label={label}
      className="-mx-4 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
    >
      <ul className="flex min-w-max gap-1.5 sm:gap-2">
        {items.map((p) => (
          <li key={p.href}>
            <Link
              href={p.href}
              scroll={false}
              aria-current={p.active ? "true" : undefined}
              className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-3.5 text-sm sm:px-4 font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:shadow-[var(--ring)] ${
                p.active
                  ? "border-[var(--color-text)] bg-[var(--color-text)] text-[var(--color-surface)]"
                  : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-2)] hover:bg-[var(--color-surface-2)]"
              }`}
            >
              {p.label}
              {p.badge}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
