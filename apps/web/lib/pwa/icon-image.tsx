import { ImageResponse } from "next/og";

/**
 * Home-screen icons drawn from the real Printio mark (same shapes as components/shell/Logo.tsx and app/icon.tsx).
 * "any" icons are the rounded tile on a transparent square. "maskable" and the Apple touch icon are full-bleed
 * accent colour with the paper mark pulled in towards the centre, so Android's circle/squircle masks and iOS's
 * rounded corners never clip it.
 */
export type PwaIconKind = "any" | "full-bleed";

export function pwaIconResponse(size: number, kind: PwaIconKind): ImageResponse {
  const bleed = kind === "full-bleed";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex" }}>
        <svg width={size} height={size} viewBox="0 0 28 28">
          {bleed ? <rect width="28" height="28" fill="#0a64d8" /> : <rect width="28" height="28" rx="8.5" fill="#0a64d8" />}
          <g transform={bleed ? "translate(14 14) scale(0.86) translate(-14 -14)" : undefined}>
            <path d="M8.5 5.5h8.2l4.8 4.8V22a1.5 1.5 0 0 1-1.5 1.5H8.5A1.5 1.5 0 0 1 7 22V7a1.5 1.5 0 0 1 1.5-1.5Z" fill="#fffefc" />
            <path d="M16.7 5.5v3.3a1.5 1.5 0 0 0 1.5 1.5h3.3Z" fill="#b9d3f5" />
            <circle cx="11" cy="18.3" r="1.7" fill="#0ea5d9" />
            <circle cx="14.3" cy="18.3" r="1.7" fill="#e03a86" />
            <circle cx="17.6" cy="18.3" r="1.7" fill="#f4b400" />
          </g>
        </svg>
      </div>
    ),
    { width: size, height: size, headers: { "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800" } },
  );
}
