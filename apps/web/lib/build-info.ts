/**
 * What is actually running right now: version, git commit, branch, host
 * environment, and when this build was produced.
 *
 * Why this exists: a Vercel Git integration can stop firing deploy hooks
 * without any visible signal - the site keeps serving happily, it just keeps
 * serving an older commit. From inside the app there was previously no way to
 * tell a deployment that included your last three pushes from one built hours
 * before them, which turns "my change isn't working" into an open-ended
 * debugging session against the wrong build. Surfacing the built commit in
 * Admin -> Settings makes that a five-second comparison against `git rev-parse
 * HEAD` instead.
 *
 * Every value here is build metadata about the operator's own deployment -
 * no secrets, nothing tenant-scoped - so this module is deliberately free of
 * `server-only` and safe to render anywhere.
 *
 * The PRINTIO_BUILD_* variables are stamped in next.config.ts at build time
 * (that is the only moment the answers are knowable); the VERCEL_* fallbacks
 * cover a host that exposes system variables at runtime instead.
 */

export interface BuildInfo {
  /** apps/web package version, e.g. "0.1.1". */
  version: string | null;
  /** Full 40-character commit sha, when the host exposed one. */
  commitSha: string | null;
  /** Git branch/ref this build came from. */
  commitRef: string | null;
  /** "production" / "preview" / "development". */
  environment: string;
  /** ISO timestamp of when this build was produced. */
  builtAt: string | null;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function getBuildInfo(): BuildInfo {
  return {
    version: nonEmpty(process.env.PRINTIO_BUILD_VERSION),
    commitSha: nonEmpty(process.env.PRINTIO_BUILD_COMMIT) ?? nonEmpty(process.env.VERCEL_GIT_COMMIT_SHA),
    commitRef: nonEmpty(process.env.PRINTIO_BUILD_REF) ?? nonEmpty(process.env.VERCEL_GIT_COMMIT_REF),
    environment: nonEmpty(process.env.VERCEL_ENV) ?? nonEmpty(process.env.NODE_ENV) ?? "development",
    builtAt: nonEmpty(process.env.PRINTIO_BUILD_TIME),
  };
}

/** The 7-character form used everywhere git surfaces a commit, so it can be
 *  eyeballed against `git rev-parse --short HEAD` without scrolling. */
export function shortSha(sha: string | null): string | null {
  if (!sha) return null;
  const trimmed = sha.trim();
  return trimmed ? trimmed.slice(0, 7) : null;
}

/**
 * "3 hours ago"-style age of a build, in the coarsest unit that still says
 * something useful. The point is not precision; it is that a build stamped
 * "6 days ago" on a repo you pushed to this morning is instantly recognizable
 * as a stalled deploy.
 *
 * Returns null for a missing or unparseable timestamp, and clamps a
 * slightly-future timestamp (clock skew between build and request) to "just
 * now" rather than rendering a negative age.
 */
export function formatBuildAge(builtAt: string | null, now: Date): string | null {
  if (!builtAt) return null;
  const built = new Date(builtAt);
  const builtMs = built.getTime();
  if (Number.isNaN(builtMs)) return null;

  const diffMinutes = Math.floor((now.getTime() - builtMs) / 60_000);
  if (diffMinutes <= 0) return "just now";
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
}
