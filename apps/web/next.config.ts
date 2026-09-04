import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Server Actions handle multipart PDF uploads; keep this in step with
  // organization_settings.max_upload_size_bytes (checked again server-side
  // regardless - this is just the framework-level ceiling).
  experimental: {
    serverActions: {
      bodySizeLimit: "100mb",
    },
  },
};

export default nextConfig;
