import { deviceTypeLabel, type DeviceTypeKey } from "./present";

/**
 * Device types that have printed a real job through Printio from the normal Print button, seen in the database
 * (print_jobs source "ipp" reaching "completed") on 2026-10-25: Windows 11 laptop, an iPhone (PrintKit) and an
 * Android phone. Edit this list only when a type has actually printed.
 */
export const CONFIRMED_DEVICE_TYPES: readonly DeviceTypeKey[] = ["windows", "iphone", "android"];

/** Set up in the add-device flow but not yet proven on a real device. */
export const STILL_TESTING_DEVICE_TYPES: readonly DeviceTypeKey[] = ["mac", "chromebook"];

export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

const shortLabel = (t: DeviceTypeKey) => (t === "iphone" ? "iPhone" : deviceTypeLabel(t).replace(/ 11$/, "").replace(/ \/ iPad$/, ""));

export function confirmedBannerText(
  lists: { confirmed: readonly DeviceTypeKey[]; testing: readonly DeviceTypeKey[] } = { confirmed: CONFIRMED_DEVICE_TYPES, testing: STILL_TESTING_DEVICE_TYPES },
): { headline: string; detail: string | null } {
  const headline = `Printing is confirmed working on ${joinWords(lists.confirmed.map(shortLabel))}.`;
  const detail = lists.testing.length > 0 ? `${joinWords(lists.testing.map(shortLabel))} ${lists.testing.length === 1 ? "is" : "are"} still being tested.` : null;
  return { headline, detail };
}
