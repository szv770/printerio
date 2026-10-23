/**
 * Fallback for the manifest's share_target. When the service worker is active it answers POST /share-target itself
 * and this route never runs. It runs only when a share arrives before the worker is installed (first launch after
 * installing, or a browser that skipped the worker). It deliberately does NOT read the body: a shared PDF can be
 * tens of megabytes and there is nothing to do with it here. It just tells the person what to do.
 */
export function POST() {
  return new Response(null, { status: 303, headers: { Location: "/print?share=notready", "Cache-Control": "no-store" } });
}

export function GET() {
  return new Response(null, { status: 303, headers: { Location: "/print", "Cache-Control": "no-store" } });
}
