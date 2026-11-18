/**
 * Pure rules for the printer setup wizard (kept out of the component so they can be tested).
 *
 * Principle (owner, 2026-11-18): the website works with every print server offline. Setting up a printer only
 * writes rows to the database; a print server picks them up whenever it connects. So the wizard never blocks on a
 * print server being online, and when a server has not reported its Windows queues yet the admin can type the queue
 * name instead of waiting.
 */

/** How the Windows queue is entered for each recipe card. */
export type QueueEntryMode =
  /** Raw-port printer: no Windows queue at all (the server prints to host:port). */
  | "raw"
  /** The chosen print server reported its queues: pick one from the list. */
  | "pick"
  /** Nothing reported yet (server offline or new): type the queue name exactly as Windows shows it. */
  | "type";

export function queueEntryMode(isRaw: boolean, discoveredQueueCount: number): QueueEntryMode {
  if (isRaw) return "raw";
  return discoveredQueueCount > 0 ? "pick" : "type";
}

/** The plain-words note under the "Register the machine" step. Never a blocker. */
export function serverStatusNote(onlineCount: number, registeredCount: number): { tone: "ready" | "waiting"; text: string } {
  if (onlineCount > 0) {
    return { tone: "ready", text: `${onlineCount} print server${onlineCount > 1 ? "s" : ""} online and ready.` };
  }
  const registered = registeredCount > 0 ? ` (${registeredCount} registered, none connected right now)` : " (none registered yet)";
  return {
    tone: "waiting",
    text: `No print server is online${registered}. That is fine: you can finish setting up now. The printer will show as waiting and start working as soon as a print server connects.`,
  };
}

/** Whether every recipe card has what it needs to be saved. */
export function allQueuesChosen(args: {
  mode: QueueEntryMode;
  cardKeys: string[];
  queueByCardKey: Record<string, string>;
  rawHostValid: boolean;
  rawPortOk: boolean;
}): boolean {
  if (args.mode === "raw") return args.rawHostValid && args.rawPortOk;
  return args.cardKeys.every((key) => (args.queueByCardKey[key] ?? "").trim() !== "");
}
