import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

let agentVersion: string | null = "0.2.1";
vi.mock("@/lib/agent-auth", () => ({ authenticateAgentRequest: async () => ({ id: "agent1", organizationId: "org1", paused: false, reported: { version: agentVersion } }) }));

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
  agentVersion = "0.2.1";
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

describe("download-url: expectedPages (PAGE messages count printed sides: what the printer should report, for printer feedback)", () => {
  it("plain duplex: copies x pages (a duplex job still reports one PAGE per side)", async () => {
    job = { ...job, source_pdf_pages: 4, copies: 2, duplex: true };
    expect((await (await get("?keepClaimed=1")).json()).printRequest.expectedPages).toBe(8);
  });
  it("plain single-sided: copies x pages", async () => {
    job = { ...job, source_pdf_pages: 3, copies: 2, duplex: false };
    expect((await (await get("?keepClaimed=1")).json()).printRequest.expectedPages).toBe(6);
  });
  it("booklet: ceil((pages + padding) / 2) x copies, and the old expectedSheets field is gone", async () => {
    job = { ...job, finishing: { staple: false, booklet: true, punch: false }, source_pdf_pages: 6, booklet_padding_added: 2, copies: 3, duplex: true, derived_file_path: "d/x.pdf", booklet_binding_side: "left" };
    const pr = (await (await get("?keepClaimed=1")).json()).printRequest;
    expect(pr.expectedPages).toBe(12);
    expect(pr.expectedSheets).toBeUndefined();
  });
});

describe("download-url: hole punch and two staples (left) reach the Agent", () => {
  const rawProfile = { id: "prof1", windows_queue_name: null, output_mode: "raw", raw_host: "10.0.0.9", raw_port: 9100, raw_staple_position: "top-left", booklet_binding_side: "left" };
  const withProfile = (p: Row) => { Object.keys(profile).forEach((k) => delete profile[k]); Object.assign(profile, p); };
  const prev = { ...profile };
  beforeEach(() => withProfile(rawProfile));
  afterAll(() => withProfile(prev));

  it("carries punch and the dual staple style in the raw target", async () => {
    job.finishing = { staple: false, booklet: false, punch: true };
    const j1 = await (await get("?keepClaimed=1")).json();
    expect(j1.printRequest.raw).toMatchObject({ punch: true });
    job.status = "claimed";
    job.finishing = { staple: true, booklet: false, punch: false, stapleStyle: "dual-left" };
    const j2 = await (await get("?keepClaimed=1")).json();
    expect(j2.printRequest.raw).toMatchObject({ stapleStyle: "dual-left" });
    expect(j2.printRequest.raw.punch).toBeUndefined();
  });

  it("a plain job's raw target is unchanged", async () => {
    const j = await (await get("?keepClaimed=1")).json();
    expect(j.printRequest.raw.punch).toBeUndefined();
    expect(j.printRequest.raw.stapleStyle).toBeUndefined();
  });

  it("an Agent older than the finishing version is refused (409), never printed without the finishing; unfinished jobs are fine", async () => {
    job.finishing = { staple: false, booklet: false, punch: true };
    for (const v of ["0.2.0", null]) {
      agentVersion = v;
      expect((await get("?keepClaimed=1")).status).toBe(409);
    }
    job.finishing = { staple: false, booklet: false, punch: false };
    agentVersion = "0.2.0";
    expect((await get("?keepClaimed=1")).status).toBe(200);
  });
});
