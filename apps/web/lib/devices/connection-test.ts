/** "Test my connection": the pure parts. The browser on the device being set up tries three addresses (our own site, a
 *  short token-free probe address, and the person's real print address) and reports only yes/no and timings. The
 *  verdict tells apart "you are offline", "this network blocks szvtech.org", and "this network blocks long random
 *  names" - the three things that stopped Windows laptops before. Nothing here ever holds the address itself. */
import { z } from "zod";

export interface ProbeResult {
  ok: boolean;
  /** Milliseconds until it answered or failed (a timeout shows as a large number). */
  ms: number;
}
export interface ConnectionReport {
  /** Our own website: proves the device has internet at all. */
  control: ProbeResult;
  /** A short sibling hostname on the same domain (no token). */
  probe: ProbeResult;
  /** The person's real print address. */
  real: ProbeResult;
}

const probeSchema = z.object({
  ok: z.boolean(),
  ms: z.number().finite().transform((n) => Math.min(60_000, Math.max(0, Math.round(n)))),
});
const reportSchema = z.object({ control: probeSchema, probe: probeSchema, real: probeSchema });

/** Strict: only these three yes/no + timing pairs get through; extra fields (such as a hostname) are dropped. */
export function parseConnectionReport(input: unknown): ConnectionReport | null {
  const parsed = reportSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export type ConnectionVerdict = "reachable" | "offline" | "address_blocked" | "domain_blocked" | "mixed";

export interface ConnectionSummary {
  verdict: ConnectionVerdict;
  tone: "success" | "warning" | "neutral";
  title: string;
  advice: string;
}

export function summarizeConnectionTest(r: ConnectionReport): ConnectionSummary {
  if (!r.control.ok) {
    return {
      verdict: "offline",
      tone: "neutral",
      title: "This device looks offline",
      advice: "Even the Printio website did not answer. Check the Wi-Fi or cable, then run the test again.",
    };
  }
  if (r.probe.ok && r.real.ok) {
    return {
      verdict: "reachable",
      tone: "success",
      title: "This network can reach your print address",
      advice: "The connection is fine. If adding the printer still fails, the problem is in the setup steps, not the network.",
    };
  }
  if (r.probe.ok && !r.real.ok) {
    return {
      verdict: "address_blocked",
      tone: "warning",
      title: "Your personal print address is blocked on this network",
      advice:
        "A short test address works but the long personal one does not. Some network filters block long random names. Try another network (for example a phone hotspot) to set this up, or ask whoever runs this network to allow it.",
    };
  }
  if (!r.probe.ok && !r.real.ok) {
    return {
      verdict: "domain_blocked",
      tone: "warning",
      title: "This network cannot reach Printio print addresses",
      advice:
        "The Printio website opens, but addresses ending in szvtech.org do not. This is usually a DNS setting or a filter on the network. Try another network, or ask whoever runs this one to allow *.szvtech.org.",
    };
  }
  return {
    verdict: "mixed",
    tone: "warning",
    title: "Mixed result",
    advice: "Only your personal address answered. Run the test again; if it repeats, send this result to your admin.",
  };
}

/** A short, token-free hostname on the same domain as the device's address (e.g. ct-probe.szvtech.org). */
export function probeHostFor(deviceHostname: string): string | null {
  const dot = deviceHostname.indexOf(".");
  if (dot < 1 || dot === deviceHostname.length - 1) return null;
  return `ct-probe${deviceHostname.slice(dot)}`;
}

/** Short label for the admin device list. */
export function connectionVerdictBadge(verdict: ConnectionVerdict): { label: string; tone: "success" | "warning" } {
  switch (verdict) {
    case "reachable":
      return { label: "Network OK", tone: "success" };
    case "offline":
      return { label: "Test: device offline", tone: "warning" };
    case "address_blocked":
      return { label: "Test: address blocked", tone: "warning" };
    case "domain_blocked":
      return { label: "Test: network blocks Printio", tone: "warning" };
    case "mixed":
      return { label: "Test: mixed result", tone: "warning" };
  }
}
