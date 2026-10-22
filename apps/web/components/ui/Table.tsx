import type { ReactNode } from "react";

export interface TableColumn<T> {
  header: string;
  cell: (row: T) => ReactNode;
  /** The row's title on a phone (shown large, without a label). One per table. */
  primary?: boolean;
  /** Right-align numbers. */
  align?: "right";
  /** Hide this column in the phone card (still in the table from md up). */
  hideOnPhone?: boolean;
}

/**
 * A data table that never overflows the page. From md up: a real <table> in a
 * card with a quiet header row. On phones: one stacked card per row (the
 * primary column as the title, the others as label / value pairs). Both
 * renderings come from the same column list, so they cannot drift apart.
 */
export function ResponsiveTable<T>({
  columns,
  rows,
  rowKey,
  caption,
}: {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  caption: string;
}) {
  const primary = (columns.find((c) => c.primary) ?? columns[0]) as TableColumn<T>;
  return (
    <>
      <div className="hidden overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] md:block">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-2)]/60">
              {columns.map((c) => (
                <th
                  key={c.header}
                  scope="col"
                  className={`px-4 py-2.5 text-xs font-medium text-[var(--color-muted)] first:pl-5 last:pr-5 ${
                    c.align === "right" ? "text-right" : "text-left"
                  }`}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {rows.map((row) => (
              <tr key={rowKey(row)} className="transition-colors hover:bg-[var(--color-surface-2)]/50">
                {columns.map((c) => (
                  <td
                    key={c.header}
                    className={`px-4 py-3 align-middle first:pl-5 last:pr-5 ${c.align === "right" ? "text-right tabular-nums" : ""} ${
                      c === primary ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-2)]"
                    }`}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul aria-label={caption} className="flex flex-col gap-3 md:hidden">
        {rows.map((row) => (
          <li
            key={rowKey(row)}
            className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)]"
          >
            <div className="text-[15px] font-medium leading-6">{primary.cell(row)}</div>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              {columns
                .filter((c) => c !== primary && !c.hideOnPhone)
                .map((c) => (
                  <div key={c.header} className="contents">
                    <dt className="text-[var(--color-muted)]">{c.header}</dt>
                    <dd className="min-w-0 text-right text-[var(--color-text-2)]">{c.cell(row)}</dd>
                  </div>
                ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
