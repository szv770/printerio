/**
 * How often a page re-runs its server render while someone is looking at it. Every refresh costs Vercel Active CPU
 * (capped on the Hobby plan), so these are deliberately slow; Realtime still pushes job changes between refreshes.
 */
/** Home and admin dashboards. */
export const HOME_REFRESH_MS = 60_000;
/** A job list or job page while a job is still moving. Paused in background tabs (see startVisibleInterval). */
export const ACTIVE_JOB_REFRESH_MS = 15_000;
