import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";

/**
 * Direct browser-to-storage uploads. Vercel rejects function request bodies over about 4.5 MB, so a big PDF cannot ride
 * inside a Server Action. Instead the browser asks for a signed upload slot (a small request), PUTs the file straight
 * to Supabase Storage, and the actions then receive only the staged path. The staged object lives under
 * gateway-intake/<userId>/ (the weekly cleanup sweeps that prefix after a day); the service role reads it back here.
 * Size is enforced HERE against the organization limit, never trusted from the browser.
 */

export { DIRECT_UPLOAD_THRESHOLD_BYTES } from "@/lib/pdf/direct-upload";

// The helper only needs the storage API, so any typed client fits.
type Db = SupabaseClient<any, any, any>;

export function stagedPathFor(userId: string, id: string = randomUUID()): string {
  return `gateway-intake/${userId}/${id}.pdf`;
}

/** Only a path this very user was given a slot for (uuid file name, no traversal) is ever read back. */
export function isOwnStagedPath(userId: string, path: unknown): path is string {
  if (typeof path !== "string") return false;
  const prefix = `gateway-intake/${userId}/`;
  if (!path.startsWith(prefix)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/.test(path.slice(prefix.length));
}

export type UploadSlotResult = { ok: true; path: string; token: string } | { ok: false; error: string };

export async function createUploadSlot(db: Db, userId: string): Promise<UploadSlotResult> {
  const path = stagedPathFor(userId);
  const { data, error } = await db.storage.from(PRINT_JOBS_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return { ok: false, error: "Printio could not prepare the upload. Try again in a moment." };
  return { ok: true, path: data.path ?? path, token: data.token };
}

const tooLarge = (maxBytes: number) => `This file is larger than the ${Math.max(1, Math.round(maxBytes / (1024 * 1024)))} MB limit.`;
const NOT_THERE = "Your file didn't finish uploading. Check your connection and submit again.";

export type StagedPdfResult = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

/** Reads a staged upload back with the service role, refusing (and deleting) anything over the organization limit. */
export async function loadStagedPdf(db: Db, userId: string, path: unknown, maxBytes: number): Promise<StagedPdfResult> {
  if (!isOwnStagedPath(userId, path)) return { ok: false, error: NOT_THERE };
  const bucket = db.storage.from(PRINT_JOBS_BUCKET);
  const slash = path.lastIndexOf("/");
  const folder = path.slice(0, slash);
  const name = path.slice(slash + 1);

  // Cheap size check first (listing metadata), so an oversized object is never pulled into memory.
  const { data: listed } = await bucket.list(folder, { search: name, limit: 5 });
  const storedSize = (listed?.find((f) => f.name === name)?.metadata as { size?: number } | null | undefined)?.size;
  if (typeof storedSize === "number" && storedSize > maxBytes) {
    await bucket.remove([path]);
    return { ok: false, error: tooLarge(maxBytes) };
  }

  const { data: blob, error } = await bucket.download(path);
  if (error || !blob || blob.size === 0) return { ok: false, error: NOT_THERE };
  if (blob.size > maxBytes) {
    await bucket.remove([path]);
    return { ok: false, error: tooLarge(maxBytes) };
  }
  return { ok: true, bytes: new Uint8Array(await blob.arrayBuffer()) };
}
