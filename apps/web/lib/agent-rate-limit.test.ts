import { describe, expect, it, vi } from "vitest";
import { fakeSupabase, failure, ok } from "@/test/fake-supabase";

vi.mock("server-only", () => ({}));
import { AGENT_POLL_MAX_PER_WINDOW, AGENT_POLL_WINDOW_SECONDS, checkAgentPollLimit } from "./agent-rate-limit";

describe("checkAgentPollLimit", () => {
  it("allows a request under the limit and counts it per agent", async () => {
    const fake = fakeSupabase(() => ok(true));
    expect(await checkAgentPollLimit(fake.client as never, "agent-1", "agents/test")).toBeNull();
    expect(fake.calls[0]).toMatchObject({ table: "check_rate_limit", values: { p_key: "agent_poll:agent-1", p_max_count: AGENT_POLL_MAX_PER_WINDOW, p_window_seconds: AGENT_POLL_WINDOW_SECONDS } });
  });

  it("answers 429 with Retry-After when over the limit", async () => {
    const fake = fakeSupabase(() => ok(false));
    const res = await checkAgentPollLimit(fake.client as never, "agent-1", "agents/test");
    expect(res?.status).toBe(429);
    const retry = Number(res?.headers.get("Retry-After"));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(AGENT_POLL_WINDOW_SECONDS);
    expect((await res!.json()).error.code).toBe("rate_limited");
  });

  it("fails open when the limiter returns an error", async () => {
    const fake = fakeSupabase(() => failure("permission denied"));
    expect(await checkAgentPollLimit(fake.client as never, "agent-1", "agents/test")).toBeNull();
  });

  it("fails open when the limiter throws", async () => {
    const broken = { rpc: () => { throw new Error("network down"); } };
    expect(await checkAgentPollLimit(broken as never, "agent-1", "agents/test")).toBeNull();
  });
});
