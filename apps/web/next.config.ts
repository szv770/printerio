import type { NextConfig } from "next";
import { version } from "./package.json";
import { buildSecurityHeaders } from "./lib/security-headers";

/**
 * Build-time deployment stamp, read back by lib/build-info.ts and shown in
 * Admin -> Settings. These have to be captured here rather than read at
 * request time: the build timestamp is only knowable while building, and a
 * host's git variables (VERCEL_GIT_*) are guaranteed present during the build
 * but only optionally exposed to the running function. Baking them in means
 * the "which commit is actually live?" question has an answer regardless of
 * how the host is configured.
 *
 * Nothing here is secret - it is version/commit/branch metadata about the
 * operator's own deployment, which is why it is safe to inline the way
 * next.config's `env` does.
 */
const buildStamp: Record<string, string> = {
  PRINTIO_BUILD_VERSION: version,
  PRINTIO_BUILD_TIME: new Date().toISOString(),
  PRINTIO_BUILD_COMMIT: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "",
  PRINTIO_BUILD_REF: process.env.VERCEL_GIT_COMMIT_REF ?? process.env.GITHUB_REF_NAME ?? "",
};

const nextConfig: NextConfig = {
  // Server Actions handle multipart PDF uploads; keep this in step with
  // organization_settings.max_upload_size_bytes (checked again server-side
  // regardless - this is just the framework-level ceiling).
  experimental: {
    serverActions: {
      bodySizeLimit: "100mb",
    },
  },
  // pdfjs-dist is loaded at request time to find where a booklet's content is (lib/pdf/content-analysis.ts); keep it
  // out of the server bundle and resolve it from node_modules instead.
  serverExternalPackages: ["pdfjs-dist"],
  env: buildStamp,
  // Hardening headers on every route (lib/security-headers.ts). The CSP in there is report-only on purpose.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: buildSecurityHeaders({
          supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
          dev: process.env.NODE_ENV === "development",
        }),
      },
    ];
  },
};

export default nextConfig;
