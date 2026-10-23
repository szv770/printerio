import { INBOX_DB_NAME, INBOX_MAX_AGE_MS, INBOX_STORE_NAME } from "./inbox";
import { buildShareRedirect, checkSharedFile, handleShare, SHARE_TARGET_PATH } from "./share";

/**
 * The text of the service worker served at /sw.js (app/sw.js/route.ts).
 *
 * It is deliberately tiny and SAFE: it caches nothing (no offline mode; a stale-app bug is worse than no offline),
 * and apart from POST /share-target every request goes straight to the network because the fetch handler does not
 * call respondWith. What it does:
 *   1. skipWaiting + clients.claim, so a new version takes over at once.
 *   2. POST /share-target: vet ONE shared PDF (lib/pwa/share.ts), keep it in IndexedDB, answer 303 -> /print?shared=<id>.
 *
 * The share logic is the real, unit-tested functions: their source text is embedded below (they are written to be
 * self-contained for exactly this reason).
 */
export function buildServiceWorkerSource({ maxBytes }: { maxBytes: number }): string {
  return `/* Printio service worker. No caching. See lib/pwa/sw-source.ts. */
"use strict";
var MAX_BYTES = ${JSON.stringify(maxBytes)};
var MAX_AGE_MS = ${JSON.stringify(INBOX_MAX_AGE_MS)};
var checkSharedFile = (${checkSharedFile.toString()});
var buildShareRedirect = (${buildShareRedirect.toString()});
var handleShare = (${handleShare.toString()});

function openInbox() {
  return new Promise(function (resolve, reject) {
    if (typeof indexedDB === "undefined" || !indexedDB) { reject(new Error("no IndexedDB")); return; }
    var req = indexedDB.open(${JSON.stringify(INBOX_DB_NAME)}, 1);
    req.onupgradeneeded = function () {
      if (!req.result.objectStoreNames.contains(${JSON.stringify(INBOX_STORE_NAME)})) {
        req.result.createObjectStore(${JSON.stringify(INBOX_STORE_NAME)}, { keyPath: "id" });
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
    req.onblocked = function () { reject(new Error("blocked")); };
  });
}

function putEntry(entry) {
  return openInbox().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(${JSON.stringify(INBOX_STORE_NAME)}, "readwrite");
      var store = tx.objectStore(${JSON.stringify(INBOX_STORE_NAME)});
      // Forget anything left over from earlier shares.
      var cursorReq = store.openCursor();
      cursorReq.onsuccess = function () {
        var cursor = cursorReq.result;
        if (cursor) {
          if (entry.at - cursor.value.at > MAX_AGE_MS) cursor.delete();
          cursor.continue();
        } else {
          store.put(entry);
        }
      };
      tx.oncomplete = function () { db.close(); resolve(); };
      tx.onerror = function () { db.close(); reject(tx.error); };
      tx.onabort = function () { db.close(); reject(tx.error || new Error("aborted")); };
    });
  });
}

self.addEventListener("install", function (event) {
  event.waitUntil(Promise.resolve(self.skipWaiting()));
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "POST") return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname !== ${JSON.stringify(SHARE_TARGET_PATH)}) return;
  event.respondWith(handleShare(request, {
    put: putEntry,
    now: function () { return Date.now(); },
    uuid: function () { return crypto.randomUUID(); },
    check: checkSharedFile,
    redirect: buildShareRedirect,
    maxBytes: MAX_BYTES
  }));
});
`;
}
