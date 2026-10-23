import type { MetadataRoute } from "next";
import { buildManifest } from "@/lib/pwa/manifest";

// Served at /manifest.webmanifest. The content (share target, icons, shortcuts) lives in lib/pwa/manifest.ts so it is unit-tested.
export default function manifest(): MetadataRoute.Manifest {
  return buildManifest();
}
