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
  { group: "Everyone", title: "The normal Print button", detail: "Windows, iPhone and Android. Nothing to install." },
  { group: "Everyone", title: "Real booklets", detail: "Left or right edge, with every page as big as it fits." },
  { group: "Everyone", title: "11x17 booklets", detail: "Letter pages at full size on a bigger sheet.", testing: true },
  { group: "Everyone", title: "Upload a PDF", detail: "Choose the pages, preview it, then print." },
  { group: "Everyone", title: "Know where your job is", detail: "Waiting, printing or printed, with a plain reason if not." },
  { group: "Everyone", title: "Whose pile is this?", detail: "Every page carries the sender's code." },
  { group: "Admins", title: "Rules and approvals", detail: "Groups, page limits, and an approval step if you want one." },
  { group: "Admins", title: "Invite with one link", detail: "No passwords to hand out." },
  { group: "Admins", title: "See every device and job", detail: "What printed, what failed, and why." },
  { group: "Admins", title: "Update from the website", detail: "One button, no remote desktop." },
  { group: "Behind the scenes", title: "A private address per device", detail: "Switch any of them off, any time." },
  { group: "Behind the scenes", title: "Your own print server", detail: "The printer never faces the internet." },
  { group: "Behind the scenes", title: "Built for real life", detail: "A paper jam does not fail a job." },
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
