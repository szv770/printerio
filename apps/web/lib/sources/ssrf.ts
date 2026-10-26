/**
 * Safety checks for fetching a link on the server ("print from a link"). The server must never be talked into
 * contacting something inside our own network or the cloud host's metadata service, so every address a name resolves
 * to is checked against this list, and anything that cannot be read as an address is refused (fail closed).
 */

/** Dotted IPv4, exactly four decimal parts of 0-255 with no leading-zero or alternative notations. */
function parseIpv4(text: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  // "0177.0.0.1" is octal in some resolvers and 177 in others: refuse any part written with a leading zero.
  if (m.slice(1).some((p) => p.length > 1 && p.startsWith("0"))) return null;
  return parts;
}

function blockedIpv4(p: number[]): boolean {
  const [a, b, c] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Expands an IPv6 text into eight 16-bit groups, or null if it is not valid IPv6. */
function parseIpv6(raw: string): number[] | null {
  let text = raw;
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(":")) return null;
  // A trailing dotted IPv4 (::ffff:1.2.3.4) counts as two groups.
  const tail = text.lastIndexOf(":");
  const last = text.slice(tail + 1);
  if (last.includes(".")) {
    const v4 = parseIpv4(last);
    if (!v4) return null;
    text = `${text.slice(0, tail + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...Array<number>(missing).fill(0), ...rest];
}

function blockedIpv6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return true; // ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  // IPv4-mapped (::ffff:a.b.c.d) and the IPv4-compatible / NAT64 forms carry an IPv4 address: judge that one.
  const mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff;
  if (mapped) return blockedIpv4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]);
  if (g0 === 0x64 && g1 === 0xff9b) return true; // NAT64: can reach IPv4 internals, refuse
  if (g.slice(0, 6).every((x) => x === 0)) return true; // deprecated IPv4-compatible ::a.b.c.d
  return false;
}

/** True when a connection to this address must be refused. Anything unreadable is refused. */
export function isBlockedAddress(address: string): boolean {
  const text = address.trim();
  if (!text) return true;
  const v4 = parseIpv4(text);
  if (v4) return blockedIpv4(v4);
  const v6 = parseIpv6(text);
  if (v6) return blockedIpv6(v6);
  return true;
}

/** An ordinary public hostname: several dot-separated labels, no IP literal, no local-looking names, no port or login. */
export function isAllowedHostname(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)) return false;
  if (/^\d+(\.\d+)*$/.test(host)) return false; // all numbers: an IP literal in disguise
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal") || lower.endsWith(".lan") || lower.endsWith(".home.arpa")) return false;
  return true;
}
