import { CONFIRMED_DEVICE_TYPES, STILL_TESTING_DEVICE_TYPES } from "./devices/confirmed";
import { deviceTypeLabel, type DeviceTypeKey } from "./devices/present";

/** Everything the public home page says, in one place. Keep it true: only list what is built, and mark what is not yet
 *  proven on a real printer. The device chips come from lib/devices/confirmed.ts, the same list as the in-app banner. */
export interface FeatureRow {
  group: "Everyone" | "Admins" | "Behind the scenes";
  title: string;
  detail: string;
  /** Built but not yet printed on paper / seen on a real device. Shown as "still testing". */
  testing?: boolean;
}

export const FEATURE_ROWS: FeatureRow[] = [
  { group: "Everyone", title: "The normal Print button", detail: "Add the printer once and print from any app on Windows, iPhone and Android, the way you print anywhere else." },
  { group: "Everyone", title: "Upload and print from the website", detail: "Drop in a PDF, choose pages with a preview, pick double-sided, staples or a booklet, and press print." },
  { group: "Everyone", title: "Real booklets", detail: "Left or right binding, so Hebrew and English both read the right way. Scans of any size are scaled as large as they fit, without cutting anything off." },
  { group: "Everyone", title: "Larger 11x17 booklets", detail: "Letter pages kept at full size on an 11x17 sheet, folded and stapled in the middle.", testing: true },
  { group: "Everyone", title: "Always know where your job is", detail: "Waiting, printing, printed or held, with a plain reason, on the phone and on the website. Try again with one tap." },
  { group: "Everyone", title: "Installs like an app", detail: "Add it to your home screen and share a PDF straight into Printio from your phone." },
  { group: "Everyone", title: "Whose pile is this?", detail: "Every page and every print job carries the sender's short code, so nobody grabs the wrong copy." },
  { group: "Admins", title: "Rules, limits and approvals", detail: "Groups, who can print what, page limits, and an approval step where you want one." },
  { group: "Admins", title: "Invite people with a link", detail: "Share one link. They sign in with their email and land in the right group. No passwords to hand out." },
  { group: "Admins", title: "See every device and every job", detail: "Which phones and laptops are connected, what printed, what failed and why, with an activity log." },
  { group: "Admins", title: "Test my connection", detail: "A one-tap check on the device being set up tells you if the network is the problem, so setup does not turn into guesswork." },
  { group: "Admins", title: "Update from the website", detail: "Press one button to update the print server and watch it restart. No remote desktop." },
  { group: "Behind the scenes", title: "Private address per device", detail: "Each device gets its own secret address that you can switch off at any time. Nothing else is shared." },
  { group: "Behind the scenes", title: "Your own print server", detail: "Jobs go to a small program in your building that talks to the printer directly. The printer never faces the internet." },
  { group: "Behind the scenes", title: "Built to survive real life", detail: "A paper jam does not fail a job, repeat clicks do not double print, and old files clean themselves up." },
];

export const FEATURE_GROUPS: FeatureRow["group"][] = ["Everyone", "Admins", "Behind the scenes"];

const short = (t: DeviceTypeKey) => (t === "iphone" ? "iPhone" : deviceTypeLabel(t).replace(/ 11$/, "").replace(/ \/ iPad$/, ""));

export function landingDevices(): { name: string; confirmed: boolean }[] {
  return [
    ...CONFIRMED_DEVICE_TYPES.map((t) => ({ name: short(t), confirmed: true })),
    ...STILL_TESTING_DEVICE_TYPES.map((t) => ({ name: short(t), confirmed: false })),
  ];
}

export const COMING_NEXT: string[] = [
  "Print straight from a link to a PDF",
  "Browse a library of texts and print them as a finished booklet, with a cover and contents page",
  "Pick pages by tapping thumbnails, like on a phone",
];
