import { CONFIRMED_DEVICE_TYPES, STILL_TESTING_DEVICE_TYPES, joinWords } from "@/lib/devices/confirmed";
import { deviceTypeLabel, type DeviceTypeKey } from "@/lib/devices/present";
import { COMING_NEXT, FEATURE_ROWS } from "@/lib/landing-content";

const short = (t: DeviceTypeKey) => (t === "iphone" ? "iPhone" : deviceTypeLabel(t).replace(/ 11$/, "").replace(/ \/ iPad$/, ""));

/** Plain-text summary for AI tools. Only what is proven or built; what is still being tested is said so. */
export function llmsText(): string {
  const built = FEATURE_ROWS.filter((f) => !f.testing);
  const testing = FEATURE_ROWS.filter((f) => f.testing);
  const lines = [
    "# Printio",
    "",
    "> Print from the normal Print button on a phone or computer to a shared school or office printer. Printio adds rules, approvals, booklets and a record of every job.",
    "",
    "## Works on real devices today",
    `Printing is confirmed working on ${joinWords(CONFIRMED_DEVICE_TYPES.map(short))}.`,
    `${joinWords(STILL_TESTING_DEVICE_TYPES.map(short))} are still being tested and are not yet confirmed.`,
    "",
    "## What it does",
    ...built.map((f) => `- ${f.title}: ${f.detail}`),
    ...(testing.length ? ["", "## Built, still being tested", ...testing.map((f) => `- ${f.title}: ${f.detail}`)] : []),
    "",
    "## Planned, not built yet",
    ...COMING_NEXT.map((c) => `- ${c}`),
    "",
    "## Pages",
    "- Home: /",
    "- Privacy: /privacy",
    "- Terms: /terms",
    "- Sign in: /login (Printio is invite only)",
    "",
  ];
  return lines.join("\n");
}

export function GET(): Response {
  return new Response(llmsText(), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
