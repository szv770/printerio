import { POLL_PRESETS } from "@/lib/poll-interval";

/** Summary text for the poll-speed card. null and undefined both mean "the PC uses its own setting". */
export function pollSpeedLabel(seconds: number | null | undefined): string {
  if (seconds == null) return "The PC's own setting";
  return POLL_PRESETS.find((p) => p.seconds === seconds)?.label ?? `Every ${seconds} seconds`;
}

/** Value for the speed <select>: "" is the PC's own setting. */
export function pollSpeedSelectValue(seconds: number | null | undefined): string {
  return seconds == null ? "" : String(seconds);
}
