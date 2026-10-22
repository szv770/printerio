import { ImageResponse } from "next/og";

// Generated favicon/app icon (no external asset needed): the Printio mark, a
// sheet of paper with a folded corner and three ink dots (C, M, Y) on the
// accent tile. Same shapes as components/shell/Logo.tsx.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex" }}>
        <svg width="32" height="32" viewBox="0 0 28 28">
          <rect width="28" height="28" rx="8.5" fill="#0a64d8" />
          <path d="M8.5 5.5h8.2l4.8 4.8V22a1.5 1.5 0 0 1-1.5 1.5H8.5A1.5 1.5 0 0 1 7 22V7a1.5 1.5 0 0 1 1.5-1.5Z" fill="#fffefc" />
          <path d="M16.7 5.5v3.3a1.5 1.5 0 0 0 1.5 1.5h3.3Z" fill="#b9d3f5" />
          <circle cx="11" cy="18.3" r="1.7" fill="#0ea5d9" />
          <circle cx="14.3" cy="18.3" r="1.7" fill="#e03a86" />
          <circle cx="17.6" cy="18.3" r="1.7" fill="#f4b400" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
