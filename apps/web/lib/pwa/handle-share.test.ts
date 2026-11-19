import { describe, expect, it } from "vitest";
import { buildShareRedirect, checkSharedFile, handleShare, sniffSharedType } from "./share";

const LIMIT = 1000;
const make = (put: (e: unknown) => Promise<void>) => ({
  put,
  now: () => 42,
  uuid: () => "id-1",
  check: checkSharedFile,
  sniff: sniffSharedType,
  redirect: buildShareRedirect,
  maxBytes: LIMIT,
});
const post = (files: File[]) => {
  const form = new FormData();
  for (const f of files) form.append("file", f);
  return new Request("https://printio.test/share-target", { method: "POST", body: form });
};
const bytes = (head: number[], n: number) => {
  const b = new Uint8Array(n);
  b.set(head.slice(0, n));
  return b;
};
const PDF_HEAD = [0x25, 0x50, 0x44, 0x46, 0x2d];
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pdf = (name = "a.pdf", n = 8) => new File([bytes(PDF_HEAD, n)], name, { type: "application/pdf" });

describe("handleShare", () => {
  it("stores one PDF and redirects 303 to /print?shared=<id>", async () => {
    const rows: Record<string, unknown>[] = [];
    const res = await handleShare(post([pdf("Quiz.pdf")]), make(async (e) => void rows.push(e as Record<string, unknown>)));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/print?shared=id-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "id-1", name: "Quiz.pdf", size: 8, at: 42 });
    expect(rows[0]!.blob).toBeInstanceOf(Blob);
  });
  it("stores a JPEG or PNG photo with the sniffed type, even when the browser labelled it generic", async () => {
    const rows: Record<string, unknown>[] = [];
    const put = async (e: unknown) => void rows.push(e as Record<string, unknown>);
    await handleShare(post([new File([bytes(JPEG_HEAD, 20)], "IMG_1.jpg", { type: "application/octet-stream" })]), make(put));
    await handleShare(post([new File([bytes(PNG_HEAD, 20)], "shot.png", { type: "" })]), make(put));
    expect(rows.map((r) => [r.name, (r.blob as Blob).type, r.size])).toEqual([
      ["IMG_1.jpg", "image/jpeg", 20],
      ["shot.png", "image/png", 20],
    ]);
  });
  it("refuses a file whose bytes are not a PDF or photo, whatever its name says", async () => {
    const rows: unknown[] = [];
    const res = await handleShare(post([new File(["MZ not a pdf"], "evil.pdf", { type: "application/pdf" })]), make(async (e) => void rows.push(e)));
    expect(res.headers.get("Location")).toBe("/print?share=notpdf");
    expect(rows).toEqual([]);
  });
  it("redirects with a reason and stores nothing for a bad file", async () => {
    const rows: unknown[] = [];
    const put = async (e: unknown) => void rows.push(e);
    expect((await handleShare(post([pdf("a.pdf", LIMIT + 1)]), make(put))).headers.get("Location")).toBe("/print?share=toolarge");
    expect((await handleShare(post([new File(["x"], "a.docx", { type: "" })]), make(put))).headers.get("Location")).toBe("/print?share=notpdf");
    expect((await handleShare(post([pdf("a.pdf", 0)]), make(put))).headers.get("Location")).toBe("/print?share=empty");
    expect((await handleShare(post([pdf("a.pdf"), pdf("b.pdf")]), make(put))).headers.get("Location")).toBe("/print?share=many");
    expect((await handleShare(post([]), make(put))).headers.get("Location")).toBe("/print?share=nofile");
    expect(rows).toEqual([]);
  });
  it("redirects to the storage notice when the browser will not keep the file", async () => {
    const res = await handleShare(
      post([pdf()]),
      make(async () => {
        throw new Error("quota");
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/print?share=storage");
  });
  it("redirects to nofile when the body is not a form", async () => {
    const res = await handleShare(
      new Request("https://printio.test/share-target", { method: "POST", body: "plain", headers: { "content-type": "text/plain" } }),
      make(async () => {}),
    );
    expect(res.headers.get("Location")).toBe("/print?share=nofile");
  });
});
