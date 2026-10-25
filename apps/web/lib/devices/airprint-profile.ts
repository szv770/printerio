/** The iPhone/iPad/Mac "AirPrint" configuration profile (com.apple.airprint) for one device address. It is built from the
 *  hostname the person already holds, never stored. Unsigned on purpose: iOS shows an "Unsigned Profile" warning and
 *  the person taps Install. UNTESTED on a real iPhone (see docs/ipp-printing.md). */
const DEVICE_HOST = /^u-[a-z2-7]{39}\.[a-z0-9.-]+\.[a-z]{2,}$/;

export function isDeviceHostname(host: string): boolean {
  return DEVICE_HOST.test(host);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildAirPrintProfile(input: {
  hostname: string;
  displayName: string;
  uuids: { content: string; profile: string };
}): string {
  if (!isDeviceHostname(input.hostname)) throw new Error("not a Printio device address");
  const name = esc(input.displayName);
  const description = "Adds this Printio printer so you can print from any app.";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><array><dict>
<key>AirPrint</key><array><dict>
<key>ForceTLS</key><true/>
<key>IPAddress</key><string>${input.hostname}</string>
<key>Port</key><integer>443</integer>
<key>ResourcePath</key><string>ipp/print</string>
</dict></array>
<key>PayloadType</key><string>com.apple.airprint</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>org.printio.airprint.${input.uuids.content}</string>
<key>PayloadUUID</key><string>${input.uuids.content}</string>
<key>PayloadDisplayName</key><string>${name}</string>
<key>PayloadDescription</key><string>${description}</string>
<key>PayloadOrganization</key><string>Printio</string>
</dict></array>
<key>PayloadDisplayName</key><string>${name}</string>
<key>PayloadDescription</key><string>${description}</string>
<key>PayloadOrganization</key><string>Printio</string>
<key>PayloadIdentifier</key><string>org.printio.profile.${input.uuids.profile}</string>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadUUID</key><string>${input.uuids.profile}</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></plist>
`;
}
