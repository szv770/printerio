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

export function createSupabaseStorage(url: string, serviceRoleKey: string): IntakeStorage {
  const client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
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
