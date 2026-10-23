// Abuse limits for the internet-facing gateway: bounded fixed-window rate limiter and client-IP resolution.
import net from "node:net";

export interface RateLimiterOptions {
  max: number;
  windowMs: number;
  now?: () => number;
  /** Upper bound on tracked keys, so a flood of distinct keys cannot grow memory. Oldest entries are evicted first. */
  maxKeys?: number;
}

export class RateLimiter {
  private readonly entries = new Map<string, { start: number; count: number }>();
  private readonly now: () => number;
  private readonly maxKeys: number;
  constructor(private readonly opts: RateLimiterOptions) {
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? 10_000;
  }
  get size(): number {
    return this.entries.size;
  }
  private current(key: string): { start: number; count: number } | undefined {
    const e = this.entries.get(key);
    if (e && this.now() - e.start >= this.opts.windowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }
  /** True when the key has already used its allowance in the current window (does not consume). */
  isLimited(key: string): boolean {
    return (this.current(key)?.count ?? 0) >= this.opts.max;
  }
  /** Consumes one hit. False when the key is over its allowance. */
  take(key: string): boolean {
    const e = this.current(key);
    if (e) {
      if (e.count >= this.opts.max) return false;
      e.count++;
      return true;
    }
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { start: this.now(), count: 1 });
    return true;
  }
}

function normalizePeer(addr: string): string {
  return addr.toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, "$1");
}

/**
 * The address to rate-limit on. CF-Connecting-IP is believed ONLY when the TCP peer is one of `trustedProxies`
 * (the local cloudflared); from any other peer the header is attacker-controlled and ignored.
 */
export function clientIpFor(
  peer: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  trustedProxies: readonly string[],
): string {
  if (!peer) return "unknown";
  const p = normalizePeer(peer);
  if (trustedProxies.some((t) => normalizePeer(t) === p)) {
    const raw = headers["cf-connecting-ip"];
    const v = typeof raw === "string" ? raw.trim() : undefined;
    if (v && net.isIP(v)) return normalizePeer(v);
  }
  return p;
}

export interface ServerLimits {
  maxConnections: number;
  perIpRequestsPerMin: number;
  globalRequestsPerMin: number;
  /** Lookups of tokens the web app does not know, per client IP per minute. */
  unknownTokensPerIpPerMin: number;
  headersTimeoutMs: number;
  /** A request body that sends nothing for this long is cut. */
  bodyStallMs: number;
  maxHeaderBytes: number;
  /** Largest body accepted from a device that is not (yet) known/active; enough for any control request. */
  unauthBodyBytes: number;
}

export const DEFAULT_LIMITS: ServerLimits = {
  maxConnections: 512,
  perIpRequestsPerMin: 600,
  globalRequestsPerMin: 3000,
  unknownTokensPerIpPerMin: 60,
  headersTimeoutMs: 20_000,
  bodyStallMs: 30_000,
  maxHeaderBytes: 16 * 1024,
  unauthBodyBytes: 64 * 1024,
};

export const DEFAULT_TRUSTED_PROXIES: readonly string[] = ["127.0.0.1", "::1"];
