import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-auth", () => ({ authenticateAgentRequest: async () => ({ id: "agent1", organizationId: "org1", paused: false }) }));

type Row = Record<string, unknown>;
let job: Row;
const events: Row[] = [];
const profile: Row = { id: "prof1", windows_queue_name: "Q", output_mode: "windows" };

const service = {
  storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/x.pdf" }, error: null }) }) },
  from(table: string) {
    if (table === "print_job_events") return { insert: async (v: Row) => (events.push(v), { error: null }) };
    if (table === "printer_profiles") {
      const q: Record<string, unknown> = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: profile, error: null }) };
      return q;
    }
    let patch: Row | null = null;
    const q: Record<string, unknown> = {
      select: () => q,
      update: (p: Row) => ((patch = p), q),
      eq: () => q,
      maybeSingle: async () => ({ data: { ...job }, error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (patch) job = { ...job, ...patch };
        resolve({ data: [{ id: job.id }], error: null });
      },
    };
    return q;
  },
};
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => service }));

import { GET } from "./route";

const get = (qs = "") => GET(new Request(`http://x/api/agents/jobs/j1/download-url${qs}`), { params: Promise.resolve({ jobId: "j1" }) });

beforeEach(() => {
  job = {
    id: "j1", organization_id: "org1", status: "claimed", lease_owner_agent_id: "agent1", lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
    printer_profile_id: "prof1", original_file_path: "o/x.pdf", derived_file_path: null, original_file_name: "x.pdf",
    finishing: { staple: false, booklet: false, punch: false }, source_pdf_pages: 1, booklet_padding_added: 0, copies: 1, color_mode: "bw",
    duplex: false, paper_size: "letter", booklet_binding_side: null, staple_position: null,
  };
  events.length = 0;
});

describe("download-url: keepClaimed (lets the agent release a job it could not send)", () => {
  it("legacy call: moves the job to downloading and says so", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).jobStatus).toBe("downloading");
    expect(job.status).toBe("downloading");
    expect(events.map((e) => e.event_type)).toEqual(["DOWNLOAD_STARTED"]);
  });

  it("?keepClaimed=1: the job STAYS claimed (the only state it can be released from), no event yet", async () => {
    const res = await get("?keepClaimed=1");
    expect(res.status).toBe(200);
    expect((await res.json()).jobStatus).toBe("claimed");
    expect(job.status).toBe("claimed");
    expect(events).toHaveLength(0);
  });

  it("a repeat call with keepClaimed is fine (agent HTTP retry)", async () => {
    expect((await get("?keepClaimed=1")).status).toBe(200);
    expect((await get("?keepClaimed=1")).status).toBe(200);
  });
});
