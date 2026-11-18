import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export const INTAKE_BUCKET = "print-jobs";

export interface IntakeStorage {
  /** Uploads the PDF bytes at `path` inside the print-jobs bucket. Throws on failure. */
  upload(path: string, bytes: Buffer): Promise<void>;
}

/** gateway-intake/<deviceId>/<uuid>.pdf, per the contract. */
export function intakePath(deviceId: string): string {
  return `gateway-intake/${deviceId}/${randomUUID()}.pdf`;
}

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

/**
 * Preferred: upload with a single-use signed token the website minted for exactly this path
 * (POST /api/gateway/intake/sign). The gateway then only needs the PUBLIC anon key, so a gateway running in someone
 * else's building holds nothing that can read other organizations' data.
 */
export function createSignedIntakeStorage(opts: {
  url: string;
  anonKey: string;
  /** Asks the website for the upload token of `path`; throws when it refuses or is unreachable. */
  sign: (path: string) => Promise<string>;
  /** Test seam: the fetch the Supabase client uses. */
  fetchImpl?: typeof fetch;
}): IntakeStorage {
  const client = createClient(opts.url, opts.anonKey, opts.fetchImpl ? { ...clientOptions, global: { fetch: opts.fetchImpl } } : clientOptions);
  return {
    async upload(path, bytes) {
      const token = await opts.sign(path);
      const { error } = await client.storage.from(INTAKE_BUCKET).uploadToSignedUrl(path, token, bytes, { contentType: "application/pdf" });
      if (error) throw new Error(`storage upload failed: ${error.message}`);
    },
  };
}

/** LEGACY: upload with the master service-role key. Kept for one release so an existing server keeps working. */
export function createSupabaseStorage(url: string, serviceRoleKey: string): IntakeStorage {
  const client = createClient(url, serviceRoleKey, clientOptions);
  return {
    async upload(path, bytes) {
      const { error } = await client.storage.from(INTAKE_BUCKET).upload(path, bytes, {
        contentType: "application/pdf",
        upsert: false,
      });
      if (error) throw new Error(`storage upload failed: ${error.message}`);
    },
  };
}
