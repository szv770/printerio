import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

vi.setConfig({ testTimeout: 30_000 });
vi.mock("server-only", () => ({}));

const requireSessionOrRedirect = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireSessionOrRedirect: () => requireSessionOrRedirect() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const uploads: Array<{ path: string; size: number }> = [];
let rateOk = true;
let uploadError: { message: string } | null = null;
const db = {
  rpc: vi.fn(async () => ({ data: rateOk, error: null })),
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { max_upload_size_bytes: 5_000_000 } }) }) }) }),
  storage: {
    from: () => ({
      upload: async (path: string, bytes: Uint8Array) => {
        uploads.push({ path, size: bytes.byteLength });
        return { error: uploadError };
      },
      createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://files.test/${path}?t=1` }, error: null }),
    }),
  },
};
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => db }));

import { buildBookletAction } from "./actions";

async function pdfFile(name: string, pages: number): Promise<File> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return new File([new Uint8Array(await doc.save())], name, { type: "application/pdf" });
}

async function form(over: Record<string, string | File> = {}, files = 2): Promise<FormData> {
  const f = new FormData();
  f.set("title", "Parshas Vayera");
  f.set("description", "Selected sichos");
  f.set("direction", "ltr");
  f.set("cover", "on");
  f.set("contents", "on");
  f.set("count", String(files));
  for (let i = 0; i < files; i++) {
    f.set(`file-${i}`, await pdfFile(`s${i}.pdf`, 3));
    f.set(`title-${i}`, `Sicha ${i + 1}`);
    f.set(`pages-${i}`, "1-2");
  }
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
}

const admin = { userId: "u1", membership: { organization_id: "o1", role: "org_admin" } };

beforeEach(() => {
  vi.clearAllMocks();
  uploads.length = 0;
  rateOk = true;
  uploadError = null;
  requireSessionOrRedirect.mockResolvedValue(admin);
});

describe("buildBookletAction", () => {
  it("builds one PDF (cover + contents + 2 + 2 pages), stores it briefly, and hands back a short-lived address", async () => {
    const res = await buildBookletAction(await form());
    expect(res.error).toBeUndefined();
    expect(res.built).toMatchObject({ fileName: "Parshas Vayera.pdf", pageCount: 6 });
    expect(res.built!.signedUrl).toContain("https://files.test/gateway-intake/booklet-u1/");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.path).toMatch(/^gateway-intake\/booklet-u1\/[0-9a-f-]{36}\.pdf$/);
  });

  it("is only for admins for now", async () => {
    requireSessionOrRedirect.mockResolvedValue({ userId: "u2", membership: { organization_id: "o1", role: "staff" } });
    expect((await buildBookletAction(await form())).error).toMatch(/admins/i);
    expect(uploads).toHaveLength(0);
  });

  it("needs an organization, a sensible count, and respects the rate limit", async () => {
    requireSessionOrRedirect.mockResolvedValue({ userId: "u3", membership: null });
    expect((await buildBookletAction(await form())).error).toMatch(/organization/i);
    requireSessionOrRedirect.mockResolvedValue(admin);
    expect((await buildBookletAction(await form({ count: "0" }))).error).toMatch(/at least one file/i);
    expect((await buildBookletAction(await form({ count: "99" }))).error).toMatch(/up to 12/i);
    rateOk = false;
    expect((await buildBookletAction(await form())).error).toMatch(/too many/i);
  });

  it("names the file that is missing or too big", async () => {
    const missing = await form();
    missing.delete("file-1");
    expect((await buildBookletAction(missing)).error).toMatch(/"Sicha 2" is missing its file/);
    const big = await form();
    big.set("file-0", new File([new Uint8Array(6_000_000)], "big.pdf", { type: "application/pdf" }));
    expect((await buildBookletAction(big)).error).toMatch(/"Sicha 1" is larger than the 5 MB limit/);
  });

  it("passes the assembler's plain messages through, and stores nothing", async () => {
    expect((await buildBookletAction(await form({ title: "  " }))).error).toMatch(/name/i);
    expect((await buildBookletAction(await form({ "pages-0": "1-9" }))).error).toMatch(/"Sicha 1"/);
    const notPdf = await form();
    notPdf.set("file-0", new File([new TextEncoder().encode("hello")], "x.pdf", { type: "application/pdf" }));
    expect((await buildBookletAction(notPdf)).error).toMatch(/could not be read as a PDF/);
    expect(uploads).toHaveLength(0);
  });

  it("builds a Hebrew booklet with a Hebrew title and a safe file name", async () => {
    const res = await buildBookletAction(await form({ title: "ליקוטי שיחות / וירא", direction: "rtl" }));
    expect(res.built).toBeTruthy();
    expect(res.built!.fileName).toBe("ליקוטי שיחות וירא.pdf");
  });

  it("says plainly when the result cannot be held on to", async () => {
    uploadError = { message: "boom" };
    expect((await buildBookletAction(await form())).error).toMatch(/could not hold on/i);
  });
});
