import Link from "next/link";
import type { ReactNode } from "react";

export interface TabItem {
  href: string;
  label: string;
  active?: boolean;
  badge?: ReactNode;
}

/** Link tabs for sibling routes (each tab is a page, not a panel). The caller
 *  says which one is active; the strip scrolls sideways on narrow screens
 *  instead of wrapping, and every tab is a 44px tap target. */
export function Tabs({ items, label = "Sections" }: { items: TabItem[]; label?: string }) {
  return (
    <nav
      aria-label={label}
      className="-mx-4 mb-6 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
    >
      <ul className="flex min-w-max gap-1 border-b border-[var(--color-border)]">
        {items.map((t) => (
          <li key={t.href}>
            <Link
              href={t.href}
              aria-current={t.active ? "page" : undefined}
              className={`relative -mb-px inline-flex min-h-11 items-center gap-2 rounded-t-[var(--radius-sm)] px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:shadow-[var(--ring)] ${
                t.active
                  ? "text-[var(--color-text)] after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-[var(--color-primary)]"
                  : "text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]/60 hover:text-[var(--color-text)]"
              }`}
            >
              {t.label}
              {t.badge}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
