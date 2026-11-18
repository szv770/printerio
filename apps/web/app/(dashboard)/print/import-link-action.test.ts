import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const requireSessionOrRedirect = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireSessionOrRedirect: () => requireSessionOrRedirect() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const fetchPdf = vi.fn();
vi.mock("@/lib/sources/fetch-pdf", () => ({ fetchPdf: (...a: unknown[]) => fetchPdf(...a) }));

const uploads: Array<{ path: string; contentType?: string }> = [];
let rateOk = true;
let uploadError: { message: string } | null = null;
const db = {
  rpc: vi.fn(async () => ({ data: rateOk, error: null })),
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { max_upload_size_bytes: 10_000_000 } }) }) }) }),
  storage: {
    from: () => ({
      upload: async (path: string, _bytes: Uint8Array, opts: { contentType?: string }) => {
        uploads.push({ path, contentType: opts.contentType });
        return { error: uploadError };
      },
      createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://files.test/${path}?token=t` }, error: null }),
    }),
  },
};
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => db }));

import { importLinkAction } from "./import-link-action";

const form = (link: string) => {
  const f = new FormData();
  f.set("link", link);
  return f;
};
const admin = { userId: "u1", membership: { organization_id: "o1", role: "org_admin" } };

beforeEach(() => {
  vi.clearAllMocks();
  uploads.length = 0;
  rateOk = true;
  uploadError = null;
  requireSessionOrRedirect.mockResolvedValue(admin);
  fetchPdf.mockResolvedValue({ ok: true, bytes: new Uint8Array([37, 80, 68, 70, 45, 49]), fileName: "Sicha.pdf" });
});

describe("importLinkAction", () => {
  it("fetches a Drive link, stores it briefly under the cleanup-swept prefix, and hands back a short-lived address", async () => {
    const res = await importLinkAction(form("https://drive.google.com/file/d/1Q6o-wEkpAsvRQIaJqSqcCOkBZhQAAdYI/view?usp=sharing"));
    expect(res.error).toBeUndefined();
    expect(res.imported).toMatchObject({ fileName: "Sicha.pdf", bytes: 6 });
    expect(res.imported!.signedUrl).toContain("https://files.test/");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.path).toMatch(/^gateway-intake\/link-import-u1\/[0-9a-f-]{36}\.pdf$/);
    expect(uploads[0]!.contentType).toBe("application/pdf");
    // fetched with the normalized address, as a Drive link, under the organization's upload limit
    const [url, kind, opts] = fetchPdf.mock.calls[0] as [URL, string, { maxBytes: number }];
    expect(url.hostname).toBe("drive.usercontent.google.com");
    expect(kind).toBe("drive");
    expect(opts.maxBytes).toBe(10_000_000);
  });

  it("is only for admins for now, and nothing is fetched for anyone else", async () => {
    requireSessionOrRedirect.mockResolvedValue({ userId: "u2", membership: { organization_id: "o1", role: "staff" } });
    const res = await importLinkAction(form("https://example.org/a.pdf"));
    expect(res.error).toMatch(/admins/i);
    expect(fetchPdf).not.toHaveBeenCalled();
  });

  it("needs an organization", async () => {
    requireSessionOrRedirect.mockResolvedValue({ userId: "u3", membership: null });
    expect((await importLinkAction(form("https://example.org/a.pdf"))).error).toMatch(/organization/i);
  });

  it("explains a bad link in plain words without fetching anything", async () => {
    const res = await importLinkAction(form("http://127.0.0.1/secret"));
    expect(res.error).toBeTruthy();
    expect(fetchPdf).not.toHaveBeenCalled();
  });

  it("is rate limited per person", async () => {
    rateOk = false;
    const res = await importLinkAction(form("https://example.org/a.pdf"));
    expect(res.error).toMatch(/too many/i);
    expect(fetchPdf).not.toHaveBeenCalled();
  });

  it("passes the fetcher's plain message through, and stores nothing, when the fetch fails", async () => {
    fetchPdf.mockResolvedValue({ ok: false, reason: "not_shared", message: "Share the file with Anyone with the link." });
    const res = await importLinkAction(form("https://example.org/a.pdf"));
    expect(res).toEqual({ error: "Share the file with Anyone with the link." });
    expect(uploads).toHaveLength(0);
  });

  it("says so plainly when the file cannot be held on to", async () => {
    uploadError = { message: "boom" };
    const res = await importLinkAction(form("https://example.org/a.pdf"));
    expect(res.error).toMatch(/could not hold on/i);
    expect(res.imported).toBeUndefined();
  });

  it("falls back to a plain file name when the link has none", async () => {
    fetchPdf.mockResolvedValue({ ok: true, bytes: new Uint8Array([37, 80, 68, 70, 45]), fileName: null });
    expect((await importLinkAction(form("https://example.org/a"))).imported?.fileName).toBe("From a link.pdf");
  });
});
