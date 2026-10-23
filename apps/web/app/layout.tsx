import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { PwaBoot } from "@/components/pwa/PwaBoot";
import { PWA_ICON_PATHS } from "@/lib/pwa/manifest";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Printio", template: "%s · Printio" },
  description: "Print management for schools and organizations.",
  applicationName: "Printio",
  // iPhone "Add to Home Screen": opens full screen with the Printio name and icon.
  appleWebApp: { capable: true, title: "Printio", statusBarStyle: "default" },
  icons: { apple: [{ url: PWA_ICON_PATHS.apple, sizes: "180x180", type: "image/png" }] },
};

export const viewport: Viewport = {
  themeColor: "#0a64d8",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen antialiased">
        {children}
        <PwaBoot />
      </body>
    </html>
  );
}
