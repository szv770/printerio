import { SHARE_MAX_BYTES } from "@/lib/pwa/share";
import { buildServiceWorkerSource } from "@/lib/pwa/sw-source";

/**
 * The service worker script. no-cache so a fixed worker reaches phones on the next visit; Service-Worker-Allowed
 * lets it control the whole site. Registration (and its kill switch) is in components/pwa/PwaBoot.tsx.
 */
export function GET() {
  return new Response(buildServiceWorkerSource({ maxBytes: SHARE_MAX_BYTES }), {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
      "Service-Worker-Allowed": "/",
    },
  });
}
