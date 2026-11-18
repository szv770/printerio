import { z } from "zod";

const schema = z.object({
  WEB_BASE_URL: z.string().url(),
  GATEWAY_SHARED_SECRET: z.string().min(32, "GATEWAY_SHARED_SECRET must be at least 32 characters"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  BASE_DOMAIN: z.string().min(3),
  PORT: z.coerce.number().int().min(1).max(65535).default(8631),
  PRINTER_NAME: z.string().min(1).default("Printio"),
  /** The org's upload limit; contract default is 50 MB. */
  MAX_UPLOAD_MB: z.coerce.number().positive().default(50),
  /** Busy guard: total bytes of uploads being processed at once (each is held in memory until it is stored). */
  MAX_INFLIGHT_UPLOAD_MB: z.coerce.number().positive().default(150),
  /** Busy guard: concurrent uploads from one device. */
  MAX_UPLOADS_PER_DEVICE: z.coerce.number().int().min(1).default(2),
  /** Abuse limits (all optional; defaults in request-limits.ts). */
  MAX_CONNECTIONS: z.coerce.number().int().min(1).default(512),
  RATE_LIMIT_PER_IP_PER_MIN: z.coerce.number().int().min(1).default(600),
  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().min(1).default(3000),
  RATE_LIMIT_UNKNOWN_TOKENS_PER_IP_PER_MIN: z.coerce.number().int().min(1).default(60),
  /** Comma-separated peers trusted to supply CF-Connecting-IP (the local cloudflared). */
  TRUSTED_PROXIES: z.string().default("127.0.0.1,::1"),
  /** "basic" advertises only "no finishing" (what the spike sent). A diagnostic switch for clients that refuse the full list. */
  ADVERTISE_FINISHINGS: z.enum(["full", "basic"]).default("full"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface GatewayConfig {
  webBaseUrl: string;
  sharedSecret: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  baseDomain: string;
  port: number;
  printerName: string;
  maxBodyBytes: number;
  maxInflightUploadBytes: number;
  maxUploadsPerDevice: number;
  limits: { maxConnections: number; perIpRequestsPerMin: number; globalRequestsPerMin: number; unknownTokensPerIpPerMin: number };
  trustedProxies: string[];
  advertiseFinishings: "full" | "basic";
  logLevel: "debug" | "info" | "warn" | "error";
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid gateway configuration (see .env.example):\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const maxBodyBytes = Math.floor(e.MAX_UPLOAD_MB * 1024 * 1024);
  return {
    webBaseUrl: e.WEB_BASE_URL.replace(/\/+$/, ""),
    sharedSecret: e.GATEWAY_SHARED_SECRET,
    supabaseUrl: e.SUPABASE_URL,
    supabaseServiceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    baseDomain: e.BASE_DOMAIN.toLowerCase().replace(/^\.+/, ""),
    port: e.PORT,
    printerName: e.PRINTER_NAME,
    maxBodyBytes,
    // Never lower than one legal file, or a file at the per-file limit could never be admitted.
    maxInflightUploadBytes: Math.max(Math.floor(e.MAX_INFLIGHT_UPLOAD_MB * 1024 * 1024), maxBodyBytes),
    maxUploadsPerDevice: e.MAX_UPLOADS_PER_DEVICE,
    limits: {
      maxConnections: e.MAX_CONNECTIONS,
      perIpRequestsPerMin: e.RATE_LIMIT_PER_IP_PER_MIN,
      globalRequestsPerMin: e.RATE_LIMIT_GLOBAL_PER_MIN,
      unknownTokensPerIpPerMin: e.RATE_LIMIT_UNKNOWN_TOKENS_PER_IP_PER_MIN,
    },
    trustedProxies: e.TRUSTED_PROXIES.split(",").map((x) => x.trim()).filter(Boolean),
    advertiseFinishings: e.ADVERTISE_FINISHINGS,
    logLevel: e.LOG_LEVEL,
  };
}
