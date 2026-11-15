import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { fakeSupabase, ok } from "@/test/fake-supabase";

vi.mock("server-only", () => ({}));
const requireSessionOrRedirect = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireSessionOrRedirect: () => requireSessionOrRedirect() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// assembleBooklet has its own tests; here only the fonts the action hands it matter.
const assembled = vi.hoisted(() => ({ inputs: [] as Record<string, unknown>[] }));
vi.mock("@/lib/booklet/assemble", async (orig) => ({
  ...(await orig<typeof import("@/lib/booklet/assemble")>()),
  assembleBooklet: async (input: Record<string, unknown>) => {
    assembled.inputs.push(input);
    return { bytes: new Uint8Array([1, 2, 3]), pageCount: 4 };
  },
}));

const HE_ID = "11111111-1111-4111-8111-111111111111";
const LATIN_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";
const fonts = new Map<string, Record<string, unknown>>([
  [HE_ID, { name: "OT Talmudis", storage_path: "org/o1/a.font", organization_id: "o1", has_hebrew: true, has_latin: false }],
  [LATIN_ID, { name: "Some Serif", storage_path: "org/o1/b.font", organization_id: "o1", has_hebrew: false, has_latin: true }],
  [OTHER_ID, { name: "Theirs", storage_path: "org/o2/c.font", organization_id: "o2", has_hebrew: true, has_latin: true }],
]);
const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof fakeSupabase> }));
vi.mock("@/lib/supabase/service-role", () => ({
  createServiceRoleClient: () => {
    const client = fake.current!.client;
    // The fake has no signed URLs; add the one call the action makes after building.
    return {
      ...client,
      storage: { from: (b: string) => ({ ...client.storage.from(b), createSignedUrl: async () => ({ data: { signedUrl: "https://files.test/x" }, error: null }) }) },
    };
  },
}));

import { buildBookletAction } from "./actions";

async function form(over: Record<string, string> = {}): Promise<FormData> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const f = new FormData();
  f.set("title", "Booklet");
  f.set("count", "1");
  f.set("file-0", new File([new Uint8Array(await doc.save())], "a.pdf", { type: "application/pdf" }));
  f.set("title-0", "A");
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  assembled.inputs = [];
  fake.current = fakeSupabase((call) => {
    if (call.table === "check_rate_limit") return ok(true);
    if (call.table === "organization_settings") return ok({ max_upload_size_bytes: 5_000_000 });
    if (call.table === "org_fonts") {
      const id = call.filters.find((f) => f[0] === "eq" && f[1] === "id")?.[2] as string;
      const org = call.filters.find((f) => f[0] === "eq" && f[1] === "organization_id")?.[2];
      const row = fonts.get(id);
      return ok(row && row.organization_id === org ? row : null);
    }
    if (call.op === "download") return ok(new Blob([new Uint8Array([7, 7])]));
    return ok();
  });
  requireSessionOrRedirect.mockResolvedValue({ userId: "u1", membership: { organization_id: "o1", role: "org_admin" } });
});

describe("buildBookletAction: fonts", () => {
  it("passes the uploaded Hebrew font, title font and English font on to the builder", async () => {
    const res = await buildBookletAction(await form({ fontId: HE_ID, titleFontId: HE_ID, latinFontId: LATIN_ID }));
    expect(res.error).toBeUndefined();
    const input = assembled.inputs[0] as { hebrewFont: Uint8Array; titleFont: Uint8Array; latinFont: { regular: Uint8Array; bold?: Uint8Array } };
    expect([...input.hebrewFont]).toEqual([7, 7]);
    expect([...input.titleFont]).toEqual([7, 7]);
    expect([...input.latinFont.regular]).toEqual([7, 7]);
    expect(input.latinFont.bold).toBeUndefined();
  });

  it("passes a bundled English font, and nothing at all when no font is chosen", async () => {
    await buildBookletAction(await form({ latinFontId: "david-libre" }));
    expect((assembled.inputs[0] as { latinFont: { bold?: Uint8Array } }).latinFont.bold?.length).toBeGreaterThan(1000);
    await buildBookletAction(await form());
    expect(assembled.inputs[1]).toMatchObject({ hebrewFont: undefined, titleFont: undefined, latinFont: undefined });
  });

  it("refuses a font of another organization, a font that covers the wrong script, and ids that are not in the list", async () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ fontId: OTHER_ID }, /no longer available/],
      [{ latinFontId: OTHER_ID }, /no longer available/],
      [{ titleFontId: LATIN_ID }, /no Hebrew letters.*title font/],
      [{ fontId: LATIN_ID }, /no Hebrew letters/],
      [{ latinFontId: HE_ID }, /no English letters/],
      [{ fontId: "not-a-uuid" }, /Choose a font from the list/],
      [{ titleFontId: "not-a-uuid" }, /Choose a title font from the list/],
      [{ latinFontId: "comic-sans" }, /Choose an English font from the list/],
    ];
    for (const [over, message] of cases) {
      const res = await buildBookletAction(await form(over));
      expect(res.error, JSON.stringify(over)).toMatch(message);
    }
    expect(assembled.inputs).toHaveLength(0);
  });
});
