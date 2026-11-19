import type { MetadataRoute } from "next";
import { routes } from "@/lib/routes";

/** Public pages only. Nothing behind sign-in belongs here. */
export const PUBLIC_PATHS = [routes.home, routes.privacy, routes.terms, routes.login] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? (prod ? `https://${prod}` : "")).replace(/\/+$/, "");
  return PUBLIC_PATHS.map((path) => ({ url: `${base}${path}` }));
}
