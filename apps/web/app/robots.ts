import type { MetadataRoute } from "next";

/** Public pages may be indexed; the signed-in app, the API and the developer preview may not. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/admin", "/api", "/dev"] }],
  };
}
