/**
 * The two extra answers the library actions can give when the switch `LIBRARY_VIA_SERVER` is ON (see lib/library/cache.ts).
 * With the switch OFF they never occur. Both are `ok: false`, so any screen that only checks `ok` and shows `message` keeps
 * working; the library browser also recognises them to offer a "Try again" button instead of an error.
 */
export type LibraryPending = {
  ok: false;
  pending: true;
  /** The print server was asked (job id in `server_jobs`); the page is not there yet. */
  jobId: string;
  message: string;
};
export type LibraryOffline = {
  ok: false;
  offline: true;
  /** No print server that can fetch library pages has reported in recently. */
  message: string;
};
export type LibraryWaiting = LibraryPending | LibraryOffline;

export function isLibraryWaiting(res: { ok: boolean }): res is LibraryWaiting {
  return res.ok === false && ("pending" in res || "offline" in res);
}

export const PENDING_MESSAGE = "Printio asked the print server for this page. It can take a minute. Press Try again.";
export const OFFLINE_MESSAGE = "The print server is not online right now, so this library page cannot be fetched. Try again when it is on.";
