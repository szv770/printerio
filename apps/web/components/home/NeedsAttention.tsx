import Link from "next/link";
import { AlertTriangle, CheckCircle2, ChevronRight, Clock, Hand, Printer, ServerCrash, Smartphone, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui";
import { adminAllClearText, type AttentionItem } from "@/lib/home/admin-home";

const ICON: Record<AttentionItem["id"], LucideIcon> = {
  agents: ServerCrash,
  printers: Printer,
  failed: AlertTriangle,
  approvals: Clock,
  held: Hand,
  devices: Smartphone,
};

export function NeedsAttention({ items }: { items: AttentionItem[] }) {
  return (
    <section aria-labelledby="needs" className="mb-6">
      <h2 id="needs" className="mb-3 text-base font-bold tracking-[-0.01em]">
        Needs attention
      </h2>
      {items.length === 0 ? (
        <Card className="flex items-center gap-3 p-4 sm:p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#dff5e8] text-[#17663a]">
            <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          </span>
          <p className="text-[15px] font-medium">{adminAllClearText()}</p>
        </Card>
      ) : (
        <Card className="p-0 sm:p-0">
          <ul className="divide-y divide-[var(--color-border)]">
            {items.map((a) => {
              const Icon = ICON[a.id];
              return (
                <li key={a.id}>
                  <Link
                    href={a.href}
                    data-tour={a.id === "approvals" ? "admin-stat-pending-approvals" : undefined}
                    className="flex min-h-16 items-center gap-3 px-4 py-3 first:rounded-t-[var(--radius-card)] last:rounded-b-[var(--radius-card)] hover:bg-[var(--color-surface-2)]/60 focus-visible:outline-none focus-visible:shadow-[var(--ring)] sm:px-5"
                  >
                    <span
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                        a.severity === "warning" ? "bg-[#fdf1cf] text-[#7a5600]" : "bg-[#fbe3ee] text-[#a21a58]"
                      }`}
                    >
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-medium">{a.title}</span>
                      {a.note && <span className="line-clamp-2 text-[13px] text-[var(--color-muted)]">{a.note}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5 text-sm font-medium text-[var(--color-primary)]">
                      <span className="hidden sm:inline">{a.action}</span>
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </section>
  );
}
