/**
 * Where the agent is willing to send raw print bytes (security review F8). The cloud tells the agent which
 * host:port to write a job to; an admin account that is hijacked or malicious could otherwise aim every job at
 * any machine on the school network (or the cloud metadata address, or this machine). Only private-LAN IPv4
 * addresses are allowed (10/8, 172.16/12, 192.168/16), whether given directly or reached through a hostname.
 * PRINTIO_RAW_ALLOWED_HOSTS (comma separated) narrows that to exactly the listed hosts.
 */
import dns from "node:dns/promises";
import net from "node:net";

export type RawTargetCheck = { ok: true; host: string; port: number } | { ok: false; reason: string };

export interface RawHostPolicyOptions {
  /** If set, only these hosts (lower-case; matched against the name given, or against every address it resolves to). */
  allowedHosts?: string[];
  /** All IPv4/IPv6 addresses a name resolves to. Injectable for tests. */
  lookup?: (hostname: string) => Promise<string[]>;
}

const NOT_PRIVATE =
  "The printer address must be a private network address (10.x.x.x, 172.16-31.x.x or 192.168.x.x). Printio will not send print data anywhere else.";

export function parseRawAllowedHosts(value: string | undefined): string[] | undefined {
  const list = (value ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

export function isPrivateLanIPv4(addr: string): boolean {
  if (!net.isIPv4(addr)) return false;
  const [a, b] = addr.split(".").map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const res = await dns.lookup(hostname, { all: true });
  return res.map((r) => r.address);
}

export async function checkRawTarget(
  target: { host: string; port: number },
  opts: RawHostPolicyOptions = {},
): Promise<RawTargetCheck> {
  const { port } = target;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: `The printer port ${String(port)} is not valid (it must be a whole number from 1 to 65535).` };
  }
  const host = (target.host ?? "").trim();
  if (!host) return { ok: false, reason: "The printer address is empty." };
  const lower = host.toLowerCase();

  let addresses: string[];
  if (net.isIP(host) !== 0) {
    addresses = [host];
  } else {
    const notFound = { ok: false, reason: `Printio could not find the printer "${host}" on the network (the name did not resolve).` } as const;
    try {
      addresses = await (opts.lookup ?? defaultLookup)(host);
    } catch {
      return notFound;
    }
    if (addresses.length === 0) return notFound;
  }

  // Every address the name can resolve to must be private, otherwise a mixed answer could be steered public.
  if (!addresses.every(isPrivateLanIPv4)) return { ok: false, reason: NOT_PRIVATE };

  const allowed = opts.allowedHosts;
  if (allowed && !allowed.includes(lower) && !addresses.every((a) => allowed.includes(a))) {
    return { ok: false, reason: `The printer address ${host} is not on this server's allowed list (PRINTIO_RAW_ALLOWED_HOSTS).` };
  }
  // Connect to the address that was checked, not to the name again, so DNS cannot change its answer in between.
  return { ok: true, host: addresses[0]!, port };
}
