import type { ComponentProps, ReactNode } from "react";
import { AdminNav } from "./AdminNav";

/**
 * The admin page frame: phones get the top bar above the page; md and up a
 * sticky sidebar beside a centered content column. No data fetching, so the
 * dev preview renders the very same frame the real app does. The `[&>main]`
 * resets neutralize the member pages' own `<main mx-auto max-w-2xl px-4 py-10>`
 * wrapper so they do not double the shell's padding or float centered.
 */
export function AdminFrame({ children, ...nav }: ComponentProps<typeof AdminNav> & { children: ReactNode }) {
  return (
    <div className="min-h-screen md:flex">
      <AdminNav {...nav} />
      <div className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-10 md:py-10 [&>main]:mx-0 [&>main]:px-0 [&>main]:py-0">
          {children}
        </div>
      </div>
    </div>
  );
}
