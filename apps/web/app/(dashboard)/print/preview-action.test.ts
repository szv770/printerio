import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({
  requireSessionOrRedirect: async () => ({ userId: "user-1", membership: { organization_id: "org-1", role: "staff" } }),
}));
vi.mock("@/lib/jobs/booklet-preview", () => ({ buildBookletPreviewPdf: vi.fn() }));

const memberRpcs: string[] = [];
const uploadedPaths: string[] = [];
const serviceRpcs: Array<{ name: string; args: unknown }> = [];
let rateResult: { data: boolean | null; error: { message: string } | null } = { data: false, error: null };
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string) => (memberRpcs.push(name), { data: true, error: null }),
    from: (table: string) => {
      const row =
        table === "printer_profiles"
          ? { output_mode: "queue", booklet_binding_side: "left", printers: { id: "pr", organization_id: "org-1" } }
          : table === "organization_settings"
            ? { max_upload_size_bytes: 52428800 }
            : { user_code: null };
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "eq"]) chain[k] = () => chain;
      chain.single = async () => ({ data: row });
      chain.maybeSingle = async () => ({ data: row });
      return chain;
    },
  }),
}));
vi.mock("@/lib/supabase/service-role", () => ({
  createServiceRoleClient: () => ({
    rpc: async (name: string, args: unknown) => (serviceRpcs.push({ name, args }), rateResult),
    storage: {
      from: () => ({
        upload: async (path: string) => (uploadedPaths.push(path), { error: null }),
        createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/p.pdf" }, error: null }),
      }),
    },
  }),
}));

import { previewBookletAction } from "./preview-action";

const form = () => {
  const f = new FormData();
  f.set("file", new File([new Uint8Array([1, 2, 3])], "a.pdf", { type: "application/pdf" }));
  f.set("booklet", "left");
  f.set("sides", "two");
  f.set("printerProfileId", "p1");
  return f;
};

beforeEach(() => {
  memberRpcs.length = 0;
  serviceRpcs.length = 0;
  rateResult = { data: false, error: null };
});

describe("previewBookletAction rate limit (security review F3)", () => {
  it("calls check_rate_limit through the service-role client with the caller's own key, never the member client", async () => {
    const res = await previewBookletAction(form());
    expect(memberRpcs).toEqual([]);
    expect(serviceRpcs).toEqual([{ name: "check_rate_limit", args: { p_key: "booklet_preview:user-1", p_max_count: 30, p_window_seconds: 300 } }]);
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/previewing too quickly/i) });
  });

  it("hands the finished preview over as a signed storage URL, never as base64 in the response", async () => {
    rateResult = { data: true, error: null };
    const { buildBookletPreviewPdf } = await import("@/lib/jobs/booklet-preview");
    vi.mocked(buildBookletPreviewPdf).mockResolvedValue({ ok: true, bytes: new Uint8Array(5_000_000), sourcePages: 4, paddedPages: 4, blankPagesAdded: 0, sheets: 1 });
    const res = await previewBookletAction(form());
    expect(res).toMatchObject({ ok: true, pdfUrl: "https://signed.example/p.pdf", sheets: 1 });
    expect(JSON.stringify(res).length).toBeLessThan(2000);
    expect(uploadedPaths[0]).toMatch(/^gateway-intake\/preview-user-1\/[0-9a-f-]{36}\.pdf$/);
  });
});
