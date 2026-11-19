import type { FetchFailure } from "./fetch-pdf";
import type { LinkProblem } from "./link";

/**
 * The few reasons a link can fail, as the screen explains them. Pure and free of server-only code so the browser can
 * use it too. The detailed sentence comes from the server (link.ts / fetch-pdf.ts); this gives each reason a short
 * heading so the person sees at a glance whether to fix the link, change the sharing, or just try again.
 */
export type LinkFailureCode = "needs_signin" | "folder" | "not_supported" | "too_big" | "blocked" | "timeout" | "not_found" | "invalid" | "try_again";

export function failureCodeForFetch(reason: FetchFailure): LinkFailureCode {
  switch (reason) {
    case "not_shared":
      return "needs_signin";
    case "not_pdf":
      return "not_supported";
    case "too_big":
      return "too_big";
    case "timeout":
      return "timeout";
    case "not_found":
      return "not_found";
    case "bad_link":
      return "invalid";
    case "blocked": // an address Printio never contacts (not a public website)
    case "rate_limited": // the site is refusing Printio's requests
    case "http": // the site answered with an error or sent Printio somewhere it could not follow
      return "blocked";
    case "network":
      return "try_again";
  }
}

export function failureCodeForLink(problem: LinkProblem): LinkFailureCode {
  return problem;
}

const TITLES: Record<LinkFailureCode, string> = {
  needs_signin: "This link needs a sign-in",
  folder: "This link is a folder",
  not_supported: "Printio can only use a PDF or a photo",
  too_big: "This file is too large",
  blocked: "The website would not let Printio download it",
  timeout: "This took too long",
  not_found: "The file is gone",
  invalid: "This does not look like a usable link",
  try_again: "Printio could not reach the website",
};

export function failureTitle(code: LinkFailureCode | undefined): string {
  return code ? TITLES[code] : "Printio could not get that file";
}

/** "50 MB" for a limit in bytes (the limit is shown to the person, so it must read naturally). */
export function formatLimit(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/** The "too large" sentence with the organization's actual limit in it. */
export function tooBigMessage(maxBytes: number): string {
  return `That file is larger than the ${formatLimit(maxBytes)} limit. Choose a smaller file, or ask an admin to raise the limit.`;
}
