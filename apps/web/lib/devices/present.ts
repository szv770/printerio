/** Pure presentation helpers for the "My devices" page (no server-only imports, safe in client components). */

export type DeviceTypeKey = "windows" | "android" | "chromebook" | "iphone" | "mac" | "other";

const TYPE_LABELS: Record<DeviceTypeKey, string> = {
  windows: "Windows 11",
  android: "Android",
  chromebook: "Chromebook",
  iphone: "iPhone / iPad",
  mac: "Mac",
  other: "Other",
};

export function deviceTypeLabel(type: string): string {
  return TYPE_LABELS[type as DeviceTypeKey] ?? "Other";
}

export interface DeviceAddress {
  /** Bare hostname, no scheme or path (what Android needs). */
  hostname: string;
  /** Full printer URL (what Windows needs). */
  url: string;
}

export function deviceAddress(hostname: string): DeviceAddress {
  return { hostname, url: `https://${hostname}/ipp/print` };
}

export type DeviceStatusKey = "revoked" | "created" | "connected" | "job_received" | "printed";

export function deviceStatus(d: {
  revoked_at: string | null;
  last_seen_at: string | null;
  first_job_at: string | null;
  first_printed_at: string | null;
}): { key: DeviceStatusKey; label: string; tone: "neutral" | "success" | "warning" } {
  if (d.revoked_at) return { key: "revoked", label: "Turned off", tone: "neutral" };
  if (d.first_printed_at) return { key: "printed", label: "Printed", tone: "success" };
  if (d.first_job_at) return { key: "job_received", label: "First print received", tone: "warning" };
  if (d.last_seen_at) return { key: "connected", label: "Connected", tone: "warning" };
  return { key: "created", label: "Address created, not connected yet", tone: "neutral" };
}

export interface SetupSteps {
  /** Which form of the address this device needs. */
  needs: "url" | "hostname";
  steps: string[];
  note?: string;
}

export function setupSteps(type: string, addr: DeviceAddress): SetupSteps | null {
  if (type === "windows") {
    return {
      needs: "url",
      steps: [
        "Open Settings > Bluetooth & devices > Printers & scanners.",
        "Click Add device, then choose \"Add manually\".",
        "Choose \"Select a shared printer by name\".",
        `Paste the full address: ${addr.url}`,
        "Click Next and follow the prompts.",
      ],
    };
  }
  if (type === "android") {
    return {
      needs: "hostname",
      steps: [
        "Open Settings > Connected devices > Connection preferences > Printing.",
        "Tap Default Print Service.",
        "Tap the menu (3 dots), then Add printer.",
        "Choose \"Add by IP/hostname\".",
        `Paste the hostname: ${addr.hostname}`,
        "Tap Add.",
      ],
      note: "Android needs the bare hostname: no \"https://\" and nothing after it.",
    };
  }
  return null;
}
