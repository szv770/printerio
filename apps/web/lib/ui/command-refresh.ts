/** How often the Print server page re-reads its data while an ordinary request is in flight. */
export const COMMAND_REFRESH_MS = 10_000;
/** Faster cadence while an update is live (progress is what the admin is watching). */
export const UPDATE_REFRESH_MS = 5_000;
/** Hard cap on refreshes per activation so a stuck request can never poll forever (about 10-20 minutes). */
export const MAX_AUTO_REFRESHES = 120;

export function refreshIntervalMs(updateLive: boolean): number {
  return updateLive ? UPDATE_REFRESH_MS : COMMAND_REFRESH_MS;
}
