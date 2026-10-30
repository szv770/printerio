"use server";

import { requireSessionOrRedirect } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { DEFAULT_MAX_UPLOAD_BYTES } from "@/lib/pdf/client-precheck";
import { createUploadSlot } from "@/lib/jobs/staged-upload";
import { logger } from "@/lib/logger";

export type UploadSlotState = { ok: true; path: string; token: string } | { ok: false; error: string };

const WINDOW_SECONDS = 10 * 60;
const MAX_PER_WINDOW = 60;

/**
 * Step one of a direct upload (large PDFs cannot travel inside a Server Action: Vercel caps request bodies near 4.5 MB).
 * After the session, membership, rate-limit and size checks, returns a one-file signed upload slot under
 * gateway-intake/<userId>/. The browser uploads straight to Storage; the print/preview actions later read the object
 * back by path and re-check its real size against the organization limit.
 */
export async function createUploadSlotAction(claimedBytes: number): Promise<UploadSlotState> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return { ok: false, error: "You are not a member of any organization yet." };

  const db = createServiceRoleClient();
  const { data: allowed, error: limitError } = await db.rpc("check_rate_limit", {
    p_key: `print_upload_slot:user:${session.userId}`,
    p_max_count: MAX_PER_WINDOW,
    p_window_seconds: WINDOW_SECONDS,
  });
  if (limitError) logger.error("rate limit check failed", { userId: session.userId, error: limitError.message });
  else if (allowed === false) return { ok: false, error: "Too many uploads in a short time. Wait a few minutes and try again." };

  const { data: settings } = await db
    .from("organization_settings")
    .select("max_upload_size_bytes")
    .eq("organization_id", session.membership.organization_id)
    .maybeSingle();
  const maxBytes = settings?.max_upload_size_bytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (typeof claimedBytes === "number" && claimedBytes > maxBytes) {
    return { ok: false, error: `This file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit.` };
  }

  const slot = await createUploadSlot(db, session.userId);
  if (!slot.ok) return slot;
  return { ok: true, path: slot.path, token: slot.token };
}
