import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/middleware", () => ({ updateSession: vi.fn() }));
import { config } from "./proxy";

const re = new RegExp(`^${config.matcher[0]}$`);

describe("proxy matcher", () => {
  it.each(["/", "/dashboard", "/admin/agents", "/api/admin/x", "/api/devices/x", "/api/cron/tick", "/api/agentsx", "/login"])("runs the session proxy for %s", (p) => {
    expect(re.test(p)).toBe(true);
  });
  it.each(["/api/agents/heartbeat", "/api/agents/jobs/1/claim", "/api/gateway/events", "/api/gateway/jobs/finalize", "/_next/static/a.js", "/favicon.ico"])("skips %s", (p) => {
    expect(re.test(p)).toBe(false);
  });
});
