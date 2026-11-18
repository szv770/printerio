/**
 * How often a page re-runs its server render while someone is looking at it. The website now runs on the owner's own PC
 * (no Vercel CPU quota), so these are short; Realtime still pushes job changes between refreshes. If the website ever
 * goes back to a metered host, raise them again.
 */
/** Home and admin dashboards. */
export const HOME_REFRESH_MS = 30_000;
/** A job list or job page while a job is still moving. Paused in background tabs (see startVisibleInterval). */
export const ACTIVE_JOB_REFRESH_MS = 4_000;
