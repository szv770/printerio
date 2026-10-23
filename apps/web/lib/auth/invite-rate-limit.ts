/** Rate limit for invite-code redemption / lookup (security review F13): stops
 *  guessing codes. Uses the existing DB-backed check_rate_limit() RPC; fails
 *  open on a database error like the other limiters. */
interface RpcClient {
  rpc(fn: "check_rate_limit", args: { p_key: string; p_max_count: number; p_window_seconds: number }): PromiseLike<{
    data: boolean | null;
    error: { message: string } | null;
  }>;
}

const WINDOW_SECONDS = 15 * 60;
const MAX_PER_USER = 10;
const MAX_PER_IP = 30;

export async function checkInviteRateLimit(
  client: RpcClient,
  who: { userId?: string; ip?: string },
): Promise<boolean> {
  const buckets: Array<[string, number]> = [];
  if (who.userId) buckets.push([`invite_redeem:user:${who.userId}`, MAX_PER_USER]);
  if (who.ip) buckets.push([`invite_redeem:ip:${who.ip}`, MAX_PER_IP]);
  for (const [key, max] of buckets) {
    const { data, error } = await client.rpc("check_rate_limit", {
      p_key: key,
      p_max_count: max,
      p_window_seconds: WINDOW_SECONDS,
    });
    if (error) continue;
    if (data === false) return false;
  }
  return true;
}

/** Best-effort client IP from proxy headers. */
export function clientIpFrom(headers: { get(name: string): string | null }): string {
  return (
    headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}
