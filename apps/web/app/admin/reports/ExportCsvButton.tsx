"use client";

import { Download } from "lucide-react";

/** RFC 4180-ish escaping - wrap in quotes and double any embedded quote
 *  whenever a cell contains a comma, quote, or newline; otherwise leave it
 *  bare (keeps the common case - plain numbers/names - readable unquoted). */
function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function toCsv(columns: string[], rows: string[][]): string {
  return [columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/**
 * Downloads the exact rows already rendered in a ReportTable as a CSV file -
 * client-side only (no server round trip, no route needed), since the data
 * is already sitting right there in the page as props. A real download
 * (not an Artifact-sandbox preview), so a plain Blob URL + synthetic click
 * works normally in the deployed app.
 */
export function ExportCsvButton({ columns, rows, filename }: { columns: string[]; rows: string[][]; filename: string }) {
  function handleClick() {
    const csv = toCsv(columns, rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex items-center gap-1 text-xs font-medium text-[var(--color-primary)] hover:underline"
    >
      <Download className="h-3.5 w-3.5" />
      Export CSV
    </button>
  );
}
