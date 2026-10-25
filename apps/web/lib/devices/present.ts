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
  /** A line to paste into a terminal (shown with a Copy button). */
  command?: string;
  /** Honest label when this way of setting up has not been proven on a real device yet. */
  testStatus?: string;
  /** Offer the "Download iPhone setup profile" button (an AirPrint configuration profile for this address). */
  profileDownload?: true;
}

export function setupSteps(type: string, addr: DeviceAddress): SetupSteps | null {
  if (type === "windows") {
    return {
      needs: "url",
      steps: [
        "Open Settings > Bluetooth & devices > Printers & scanners.",
        "Click Add device, then choose \"Add manually\".",
        "Choose \"Add a printer using an IP address or hostname\" and click Next.",
        "If it asks for a device type, pick \"IPP Device\" (not Autodetect or TCP/IP).",
        `Paste the full address, starting with https://: ${addr.url}`,
        "Click Next. It says \"Contacting printer\" for about 30 seconds, then \"You've successfully added Printio\".",
      ],
      note: "Proven on a Windows 11 laptop (the full address pasted into the hostname box). The \"shared printer by name\" route has not worked.",
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
  if (type === "iphone") {
    return {
      needs: "hostname",
      profileDownload: true,
      testStatus: "Not tested yet - being worked on",
      note: "We have not tried this on a real iPhone yet, so it may not work. If it does not, use Print a document on the website.",
      steps: [
        "Open this page in Safari on your iPhone or iPad (other browsers cannot install profiles). Not in Safari? Tap Share, then Open in Safari.",
        "Tap Download iPhone setup profile. When it asks, tap Allow, then Close.",
        "Open Settings and tap Profile Downloaded near the top. Tap Install (top right), enter your passcode.",
        "A warning says Unsigned Profile. That is normal. Tap Install again, then Install, then Done.",
        "To print: open a document or photo, tap Share, then Print, tap Printer, and choose your Printio printer. If it is not listed, wait 10 seconds and tap Printer again.",
      ],
    };
  }
  if (type === "mac") {
    const ipps = `ipps://${addr.hostname}/ipp/print`;
    return {
      needs: "hostname",
      testStatus: "Not tested yet - being worked on",
      note: "We have not tried this on a real Mac yet. Earlier tests with other printers suggest it can work, but we cannot promise it. If it does not work, use Print a document on the website.",
      command: `lpadmin -p Printio -E -v ${ipps} -m everywhere`,
      steps: [
        "Recommended: open Terminal (press Command + Space, type Terminal, press Return).",
        "Paste the line below and press Return. If nothing is printed back, it was added.",
        "Or, without Terminal: open System Settings > Printers & Scanners > Add Printer, then the IP tab.",
        `On the IP tab set Address to ${addr.hostname}:443, Protocol to IPPS (secure IPP), and Queue to ipp/print.`,
      ],
    };
  }
  return null;
}

/** Best guess of the device type from a browser user agent (the person can change it). */
export function detectDeviceType(userAgent: string | undefined | null, maxTouchPoints = 0): DeviceTypeKey {
  const ua = userAgent ?? "";
  if (/CrOS/i.test(ua)) return "chromebook";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iphone";
  // iPadOS 13+ reports itself as a Mac; a Mac with a touch screen is an iPad.
  if (/Macintosh|Mac OS X/i.test(ua)) return maxTouchPoints > 1 ? "iphone" : "mac";
  if (/Windows/i.test(ua)) return "windows";
  return "other";
}

/** What to tell someone when we have no step-by-step help for their device type. */
export function noStepsMessage(type: string): string {
  if (type === "other") return "We don't have steps for this kind of device yet. It may not work.";
  return `We don't have steps for ${deviceTypeLabel(type)} yet. It may not work, so ask your administrator if you get stuck.`;
}
