import { beforeEach, describe, expect, it } from "vitest";
import { clearDraft, readDraft, saveDraft, type BuilderDraft } from "./draft";

const draft = (over: Partial<BuilderDraft> = {}): BuilderDraft => ({ sources: [], title: "T", description: "D", direction: "rtl", cover: true, contents: false, ...over });

describe("booklet builder draft (kept while you visit the library and come back)", () => {
  beforeEach(() => clearDraft());

  it("is empty at first, keeps what was saved, and can be cleared", () => {
    expect(readDraft()).toBeNull();
    saveDraft(draft());
    expect(readDraft()).toMatchObject({ title: "T", direction: "rtl", contents: false });
    clearDraft();
    expect(readDraft()).toBeNull();
  });

  it("keeps the person's files exactly as they were", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "a.pdf", { type: "application/pdf" });
    saveDraft(draft({ sources: [{ id: 4, title: "A", file, bytes: new ArrayBuffer(3), totalPages: 2, pages: "1", credit: "" }] }));
    expect(readDraft()!.sources[0]).toMatchObject({ id: 4, title: "A", totalPages: 2, pages: "1" });
    expect(readDraft()!.sources[0]!.file).toBe(file);
  });
});
