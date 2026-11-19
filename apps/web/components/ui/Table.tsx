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
  /** Keep this column's text on one line in the table (dates, names, counts). */
  nowrap?: boolean;
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
  rowClassName,
  expanded,
}: {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  caption: string;
  /** Extra classes for a row / card (e.g. to tint rows that need attention). */
  rowClassName?: (row: T) => string;
  /** Full-width detail shown under a row (table) or at the bottom of its card (phone). Return null for none. */
  expanded?: (row: T) => ReactNode;
}) {
  const primary = (columns.find((c) => c.primary) ?? columns[0]) as TableColumn<T>;
  return (
    <>
      {/* Below xl the card scrolls sideways if it must; from xl up it does not clip, so the header can stay stuck to the top of the page while the rows scroll. */}
      <div className="hidden overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] md:block xl:overflow-visible">
        <table className="printio-quiet-table w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.header}
                  scope="col"
                  className={`border-b border-[var(--color-border)] bg-[var(--color-thead)] px-4 py-2.5 text-xs font-semibold tracking-wide text-[var(--color-muted)] first:rounded-tl-[calc(var(--radius-card)-1px)] first:pl-5 last:rounded-tr-[calc(var(--radius-card)-1px)] last:pr-5 xl:sticky xl:top-0 xl:z-10 ${
                    c.align === "right" ? "text-right" : "text-left"
                  }`}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)] [&>tr:last-child>td:first-child]:rounded-bl-[calc(var(--radius-card)-1px)] [&>tr:last-child>td:last-child]:rounded-br-[calc(var(--radius-card)-1px)]">
            {rows.flatMap((row) => {
              const detail = expanded?.(row);
              const tint = rowClassName?.(row) ?? "";
              return [
                <tr key={rowKey(row)} className={`group/row transition-colors hover:bg-[var(--color-surface-2)]/45 ${tint}`}>
                  {columns.map((c) => (
                    <td
                      key={c.header}
                      className={`px-4 py-3.5 align-middle first:pl-5 last:pr-5 ${c.align === "right" ? "text-right tabular-nums" : ""} ${c.nowrap ? "whitespace-nowrap" : ""} ${
                        c === primary ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-2)]"
                      }`}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>,
                ...(detail
                  ? [
                      <tr key={`${rowKey(row)}-detail`} className={tint}>
                        <td colSpan={columns.length} className="px-5 pt-0 pb-5">
                          {detail}
                        </td>
                      </tr>,
                    ]
                  : []),
              ];
            })}
          </tbody>
        </table>
      </div>

      <ul aria-label={caption} className="flex flex-col gap-3 md:hidden">
        {rows.map((row) => (
          <li
            key={rowKey(row)}
            className={`rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)] ${rowClassName?.(row) ?? ""}`}
          >
            <div className="min-w-0 text-[15px] font-medium leading-6 [overflow-wrap:anywhere]">{primary.cell(row)}</div>
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 border-t border-[var(--color-border)] pt-3 text-[13px]">
              {columns
                .filter((c) => c !== primary && !c.hideOnPhone)
                .map((c) => (
                  <div key={c.header} className="contents">
                    <dt className="text-xs font-medium text-[var(--color-muted)]">{c.header}</dt>
                    <dd className="min-w-0 text-right text-[var(--color-text-2)] [overflow-wrap:anywhere]">{c.cell(row)}</dd>
                  </div>
                ))}
            </dl>
            {expanded?.(row)}
          </li>
        ))}
      </ul>
    </>
  );
}
