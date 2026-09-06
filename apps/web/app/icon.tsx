import { ImageResponse } from "next/og";

// Generated favicon/app icon (no external asset needed) - a simple printer
// glyph on the app's primary brand color. Next.js App Router serves this
// automatically wherever a favicon/icon is requested.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#2563eb",
          borderRadius: 6,
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
          <path d="M6 9V3h12v6" strokeLinecap="round" strokeLinejoin="round" />
          <path
            d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <rect x="6" y="14" width="12" height="8" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
