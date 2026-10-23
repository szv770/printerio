import { describe, expect, it } from "vitest";
import { buildShareRedirect, checkSharedFile, handleShare } from "./share";

const LIMIT = 1000;
const make = (put: (e: unknown) => Promise<void>) => ({
  put,
  now: () => 42,
  uuid: () => "id-1",
  check: checkSharedFile,
  redirect: buildShareRedirect,
  maxBytes: LIMIT,
});
const post = (files: File[]) => {
  const form = new FormData();
  for (const f of files) form.append("file", f);
  return new Request("https://printio.test/share-target", { method: "POST", body: form });
};
const pdf = (name = "a.pdf", n = 8) => new File([new Uint8Array(n)], name, { type: "application/pdf" });

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
  it("redirects with a reason and stores nothing for a bad file", async () => {
    const rows: unknown[] = [];
    const put = async (e: unknown) => void rows.push(e);
    expect((await handleShare(post([pdf("a.pdf", LIMIT + 1)]), make(put))).headers.get("Location")).toBe("/print?share=toolarge");
    expect((await handleShare(post([new File(["x"], "a.png", { type: "image/png" })]), make(put))).headers.get("Location")).toBe("/print?share=notpdf");
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
