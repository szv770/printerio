import { describe, expect, it, vi } from "vitest";
import { stagedPathFor, isOwnStagedPath, loadStagedPdf, createUploadSlot, DIRECT_UPLOAD_THRESHOLD_BYTES } from "./staged-upload";

const UID = "11111111-1111-4111-8111-111111111111";

function fakeDb(opts: { listSize?: number | null; download?: Uint8Array | null; signError?: boolean }) {
  const remove = vi.fn(async (_paths: string[]) => ({ error: null }));
  const bucket = {
    list: vi.fn(async () => ({ data: opts.listSize == null ? [] : [{ name: "f.pdf", metadata: { size: opts.listSize } }], error: null })),
    download: vi.fn(async (_p: string) => (opts.download ? { data: new Blob([opts.download as BlobPart]), error: null } : { data: null, error: { message: "nope" } })),
    remove,
    createSignedUploadUrl: vi.fn(async (p: string) => (opts.signError ? { data: null, error: { message: "x" } } : { data: { path: p, token: "tok", signedUrl: "https://x/u" }, error: null })),
  };
  return { db: { storage: { from: () => bucket } } as never, bucket };
}

/** The listing returns the file under its own name, so mirror the uuid file name the loader asks for. */
function withName(path: string, size: number | null) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (bucket: { list: ReturnType<typeof vi.fn> }) =>
    bucket.list.mockImplementation(async () => ({ data: size == null ? [] : [{ name, metadata: { size } }], error: null }));
}

describe("staged paths", () => {
  it("builds a unique pdf path under gateway-intake/<userId>/ and recognises only the caller's own", () => {
    const a = stagedPathFor(UID);
    expect(a).toMatch(new RegExp(`^gateway-intake/${UID}/[0-9a-f-]{36}\\.pdf$`));
    expect(stagedPathFor(UID)).not.toBe(a);
    expect(isOwnStagedPath(UID, a)).toBe(true);
    expect(isOwnStagedPath("other", a)).toBe(false);
    expect(isOwnStagedPath(UID, `gateway-intake/${UID}/../x.pdf`)).toBe(false);
    expect(isOwnStagedPath(UID, "org/o/jobs/j/original.pdf")).toBe(false);
    expect(isOwnStagedPath(UID, `gateway-intake/${UID}/abc.pdf`)).toBe(false);
    expect(isOwnStagedPath(UID, undefined)).toBe(false);
  });
  it("sends files above ~3.5 MB the direct way", () => {
    expect(DIRECT_UPLOAD_THRESHOLD_BYTES).toBe(3_500_000);
  });
});

describe("createUploadSlot", () => {
  it("returns the path and token of a signed upload url", async () => {
    const { db } = fakeDb({});
    const r = await createUploadSlot(db, UID);
    expect(r).toMatchObject({ ok: true, token: "tok" });
    if (r.ok) expect(isOwnStagedPath(UID, r.path)).toBe(true);
  });
  it("fails plainly when storage refuses", async () => {
    const { db } = fakeDb({ signError: true });
    expect(await createUploadSlot(db, UID)).toMatchObject({ ok: false });
  });
});

describe("loadStagedPdf", () => {
  const path = stagedPathFor(UID);
  it("rejects a path that is not the caller's, without touching storage", async () => {
    const { db, bucket } = fakeDb({ download: new Uint8Array([1]) });
    expect(await loadStagedPdf(db, UID, "gateway-intake/someone-else/x.pdf", 100)).toMatchObject({ ok: false });
    expect(bucket.download).not.toHaveBeenCalled();
  });
  it("returns the bytes of a staged object within the limit", async () => {
    const { db, bucket } = fakeDb({ download: new Uint8Array([1, 2, 3]) });
    withName(path, 3)(bucket);
    const r = await loadStagedPdf(db, UID, path, 100);
    expect(r.ok && Array.from(r.bytes)).toEqual([1, 2, 3]);
  });
  it("refuses an object over the limit by its stored size, without downloading, and removes it", async () => {
    const { db, bucket } = fakeDb({ download: new Uint8Array([1]) });
    withName(path, 500)(bucket);
    const r = await loadStagedPdf(db, UID, path, 100);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/larger than/i) });
    expect(bucket.download).not.toHaveBeenCalled();
    expect(bucket.remove).toHaveBeenCalledWith([path]);
  });
  it("still checks the real size after download when the listing has no size", async () => {
    const { db, bucket } = fakeDb({ download: new Uint8Array(200) });
    withName(path, null)(bucket);
    expect(await loadStagedPdf(db, UID, path, 100)).toMatchObject({ ok: false, error: expect.stringMatching(/larger than/i) });
    expect(bucket.remove).toHaveBeenCalledWith([path]);
  });
  it("says the upload did not finish when the object is missing", async () => {
    const { db } = fakeDb({ download: null });
    expect(await loadStagedPdf(db, UID, path, 100)).toMatchObject({ ok: false, error: expect.stringMatching(/didn't finish uploading/i) });
  });
});
