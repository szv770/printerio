import type { MetadataRoute } from "next";
import { SHARE_TARGET_PATH } from "./share";

/** Colours are the design tokens in app/globals.css (--color-bg, --color-primary). */
export const PWA_BACKGROUND = "#f5f3ef";
export const PWA_THEME = "#0a64d8";

export const PWA_ICON_PATHS = {
  any192: "/pwa/icon-192.png",
  any512: "/pwa/icon-512.png",
  maskable192: "/pwa/maskable-192.png",
  maskable512: "/pwa/maskable-512.png",
  apple: "/pwa/apple-touch-icon.png",
} as const;

export function buildManifest() {
  const manifest: MetadataRoute.Manifest = {
    id: "/",
    name: "Printio",
    short_name: "Printio",
    description: "Print from your phone: pick or share a PDF, choose the options, press Print.",
    start_url: "/home",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: PWA_BACKGROUND,
    theme_color: PWA_THEME,
    icons: [
      { src: PWA_ICON_PATHS.any192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: PWA_ICON_PATHS.any512, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: PWA_ICON_PATHS.maskable192, sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: PWA_ICON_PATHS.maskable512, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Print a document", short_name: "Print", url: "/print", icons: [{ src: PWA_ICON_PATHS.any192, sizes: "192x192", type: "image/png" }] },
      { name: "My jobs", url: "/jobs", icons: [{ src: PWA_ICON_PATHS.any192, sizes: "192x192", type: "image/png" }] },
    ],
    share_target: {
      action: SHARE_TARGET_PATH,
      method: "POST",
      enctype: "multipart/form-data",
      params: { files: [{ name: "file", accept: ["application/pdf", ".pdf"] }] },
    } as unknown as MetadataRoute.Manifest["share_target"], // Next types `files` as DOM File[]; the manifest spec wants {name, accept}[]
  };
  return manifest;
}
