import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, failure, ok, type FakeCall } from "@/test/fake-supabase";
import { EZRA_SIL_REGULAR_BASE64 } from "@/lib/booklet/fonts/ezra-sil-regular";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let allowed = true;
vi.mock("@/lib/auth/session", () => ({
  requireOrgRole: async () => {
    if (!allowed) throw new Error("FORBIDDEN");
    return { userId: "admin-1", membership: { organization_id: "org1", role: "org_admin" } };
  },
}));
const auditCalls: unknown[] = [];
const member = { from: (t: string) => ({ insert: async (v: unknown) => (auditCalls.push({ t, v }), { error: null }) }) };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => member }));

let responder: (call: FakeCall) => ReturnType<typeof ok>;
let fake: ReturnType<typeof fakeSupabase>;
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => fake.client }));

import { deleteFontAction, uploadFontAction } from "./actions";

const ezra = new Uint8Array(Buffer.from(EZRA_SIL_REGULAR_BASE64, "base64"));
const fileForm = (bytes: Uint8Array, name = "EzraSIL.ttf") => {
  const fd = new FormData();
  fd.set("file", new File([bytes as BlobPart], name));
  return fd;
};

/** Default answers: rate limit allows, no fonts yet, storage and insert succeed. */
function defaults(overrides: Partial<Record<string, (call: FakeCall) => ReturnType<typeof ok> | undefined>> = {}) {
  return (call: FakeCall) => {
    const key = `${call.table}:${call.op}`;
    const custom = overrides[key]?.(call);
    if (custom) return custom;
    if (call.op === "rpc") return ok(true);
    if (call.table === "org_fonts" && call.op === "select") return ok([]);
    return ok();
  };
}
const setup = (r: ReturnType<typeof defaults>) => {
  responder = r;
  fake = fakeSupabase((c) => responder(c));
};
const ops = (table: string, op: string) => fake.calls.filter((c) => c.table === table && c.op === op);

beforeEach(() => {
  allowed = true;
  auditCalls.length = 0;
  setup(defaults());
});

describe("uploadFontAction", () => {
  it("is org_admin only", async () => {
    allowed = false;
    await expect(uploadFontAction(fileForm(ezra))).rejects.toThrow("FORBIDDEN");
    expect(fake.calls).toHaveLength(0);
  });

  it("stores the bytes under org/{org}/{fontId}.font, then inserts the row, then audits", async () => {
    const r = await uploadFontAction(fileForm(ezra));
    expect(r).toEqual({ ok: true, message: 'Added "Ezra SIL".' });
    const [upload] = ops("storage:org-fonts", "upload");
    const { path } = upload!.values as { path: string };
    expect(path).toMatch(/^org\/org1\/[0-9a-f-]{36}\.font$/);
    const [insert] = ops("org_fonts", "insert");
    expect(insert!.values).toMatchObject({
      organization_id: "org1",
      name: "Ezra SIL",
      file_name: "EzraSIL.ttf",
      storage_path: path,
      size_bytes: ezra.length,
      has_vowels: true,
      has_cantillation: true,
      created_by: "admin-1",
    });
    expect(path).toBe(`org/org1/${(insert!.values as { id: string }).id}.font`);
    expect(fake.calls.indexOf(upload!)).toBeLessThan(fake.calls.indexOf(insert!));
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({ t: "audit_logs", v: { action: "font.uploaded", organization_id: "org1", actor_id: "admin-1" } });
  });

  it("rejects a missing, empty or non-font file with a plain message and stores nothing", async () => {
    expect((await uploadFontAction(new FormData())).ok).toBe(false);
    expect((await uploadFontAction(fileForm(new Uint8Array(0)))).ok).toBe(false);
    const r = await uploadFontAction(fileForm(new Uint8Array(500).fill(7), "notes.ttf"));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/\.ttf or \.otf/);
    expect(ops("storage:org-fonts", "upload")).toHaveLength(0);
    expect(ops("org_fonts", "insert")).toHaveLength(0);
  });

  it("rejects a file over 8 MB before reading it", async () => {
    const big = { size: 8 * 1024 * 1024 + 1, name: "big.ttf", arrayBuffer: async () => new ArrayBuffer(0) } as unknown as File;
    const fd = { get: () => big } as unknown as FormData;
    const r = await uploadFontAction(fd);
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/8 MB/) });
    expect(fake.calls).toHaveLength(0);
  });

  it("is rate limited", async () => {
    setup(defaults({ "check_rate_limit:rpc": () => ok(false) }));
    const r = await uploadFontAction(fileForm(ezra));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/wait/i);
    expect(ops("storage:org-fonts", "upload")).toHaveLength(0);
  });

  it("refuses a duplicate name with a clear message", async () => {
    setup(defaults({ "org_fonts:select": () => ok([{ id: "x", name: "ezra sil" }]) }));
    const r = await uploadFontAction(fileForm(ezra));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/already uploaded/);
    expect(ops("storage:org-fonts", "upload")).toHaveLength(0);
  });

  it("refuses a 13th font", async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, name: `Font ${i}` }));
    setup(defaults({ "org_fonts:select": () => ok(twelve) }));
    const r = await uploadFontAction(fileForm(ezra));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/12 fonts/);
    expect(ops("storage:org-fonts", "upload")).toHaveLength(0);
  });

  it("removes the stored file when the row insert fails", async () => {
    setup(defaults({ "org_fonts:insert": () => failure("db down") }));
    const r = await uploadFontAction(fileForm(ezra));
    expect(r.ok).toBe(false);
    const { path } = ops("storage:org-fonts", "upload")[0]!.values as { path: string };
    expect(ops("storage:org-fonts", "remove")[0]!.values).toEqual([path]);
    expect(auditCalls).toHaveLength(0);
  });

  it("maps a unique-violation race to the duplicate message and cleans up", async () => {
    setup(defaults({ "org_fonts:insert": () => ({ data: null, error: { message: "dup", code: "23505" } as never }) }));
    const r = await uploadFontAction(fileForm(ezra));
    expect(r.message).toMatch(/already uploaded/);
    expect(ops("storage:org-fonts", "remove")).toHaveLength(1);
  });

  it("does not insert a row when the storage upload fails", async () => {
    setup(defaults({ "storage:org-fonts:upload": () => failure("bucket down") }));
    const r = await uploadFontAction(fileForm(ezra));
    expect(r.ok).toBe(false);
    expect(ops("org_fonts", "insert")).toHaveLength(0);
  });
});

describe("deleteFontAction", () => {
  const row = { id: "f1", name: "Ezra SIL", storage_path: "org/org1/f1.font" };

  it("is org_admin only", async () => {
    allowed = false;
    await expect(deleteFontAction("f1")).rejects.toThrow("FORBIDDEN");
    expect(fake.calls).toHaveLength(0);
  });

  it("looks the font up in the caller's organization, removes the file, then the row", async () => {
    setup(defaults({ "org_fonts:select": () => ok(row) }));
    const r = await deleteFontAction("f1");
    expect(r).toEqual({ ok: true, message: 'Removed "Ezra SIL".' });
    const select = ops("org_fonts", "select")[0]!;
    expect(select.filters).toContainEqual(["eq", "organization_id", "org1"]);
    expect(ops("storage:org-fonts", "remove")[0]!.values).toEqual(["org/org1/f1.font"]);
    const del = ops("org_fonts", "delete")[0]!;
    expect(del.filters).toContainEqual(["eq", "id", "f1"]);
    expect(del.filters).toContainEqual(["eq", "organization_id", "org1"]);
    expect(auditCalls[0]).toMatchObject({ v: { action: "font.deleted" } });
  });

  it("will not touch another organization's font (not found in this org)", async () => {
    setup(defaults({ "org_fonts:select": () => ok(null) }));
    const r = await deleteFontAction("f-other");
    expect(r.ok).toBe(false);
    expect(ops("storage:org-fonts", "remove")).toHaveLength(0);
    expect(ops("org_fonts", "delete")).toHaveLength(0);
  });

  it("keeps the row when the file could not be removed, so it can be retried", async () => {
    setup(defaults({ "org_fonts:select": () => ok(row), "storage:org-fonts:remove": () => failure("nope") }));
    const r = await deleteFontAction("f1");
    expect(r.ok).toBe(false);
    expect(ops("org_fonts", "delete")).toHaveLength(0);
  });
});
