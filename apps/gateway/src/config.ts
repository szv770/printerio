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
  return {
    webBaseUrl: e.WEB_BASE_URL.replace(/\/+$/, ""),
    sharedSecret: e.GATEWAY_SHARED_SECRET,
    supabaseUrl: e.SUPABASE_URL,
    supabaseServiceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    baseDomain: e.BASE_DOMAIN.toLowerCase().replace(/^\.+/, ""),
    port: e.PORT,
    printerName: e.PRINTER_NAME,
    maxBodyBytes: Math.floor(e.MAX_UPLOAD_MB * 1024 * 1024),
    logLevel: e.LOG_LEVEL,
  };
}
