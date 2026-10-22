// Device tokens for the IPP gateway: the secret in a member device's hostname (u-<token>.<base domain>).
// Node-only (node:crypto), so it is exposed as the subpath "@printio/shared/device-token" and is deliberately
// NOT re-exported from index.ts (a client component imports the index; node:crypto would break its bundle).
// See docs/superpowers/specs/2026-10-22-gateway-contract.md.
import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"; // RFC 4648 base32, lowercase
export const DEVICE_TOKEN_BYTES = 24;
/** 24 bytes = 192 bits -> ceil(192 / 5) base32 characters. */
export const DEVICE_TOKEN_LENGTH = 39;

const TOKEN_RE = /^[a-z2-7]{39}$/;

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function generateDeviceToken(): string {
  return base32(randomBytes(DEVICE_TOKEN_BYTES));
}

export function isDeviceToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

/** Lowercase hex SHA-256 of the token string: the only form that is stored. */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function deviceHostname(token: string, baseDomain: string): string {
  return `u-${token}.${baseDomain.toLowerCase()}`;
}

/** Reads the token out of a Host header ("u-<token>.<base>" with an optional :port). Null if it does not match. */
export function tokenFromHost(host: string | undefined, baseDomain: string): string | null {
  if (!host) return null;
  const bare = host.trim().toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${baseDomain.trim().toLowerCase()}`;
  if (!bare.startsWith("u-") || !bare.endsWith(suffix)) return null;
  const token = bare.slice(2, bare.length - suffix.length);
  return isDeviceToken(token) ? token : null;
}
