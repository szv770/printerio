/**
 * What "Report a problem" sends. Deliberately short: the page address (no search or hash), the error reference if
 * there is one, the build version, and the browser. No name, email, job content or anything the person typed.
 */

export interface ReportDetails {
  page: string;
  digest?: string | null;
  build: string;
  browser: string;
}

export function reportBody(d: ReportDetails): string {
  return [
    "Please describe what you were trying to do and what went wrong:",
    "",
    "",
    "---- Details (added automatically) ----",
    `Page: ${d.page}`,
    d.digest ? `Error reference: ${d.digest}` : null,
    `Printio version: ${d.build}`,
    `Browser: ${d.browser}`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

export function detailsText(d: ReportDetails): string {
  return reportBody(d).split("---- Details (added automatically) ----\n")[1] ?? "";
}

export function reportMailto(email: string, d: ReportDetails): string {
  const subject = "Printio problem report";
  return `mailto:${encodeURIComponent(email).replace(/%40/g, "@")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(reportBody(d))}`;
}

/** Page path only: never the query string or hash (those can hold codes). */
export function safePagePath(pathname: string | null | undefined): string {
  return (pathname ?? "").split(/[?#]/)[0] || "/";
}
