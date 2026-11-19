import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attr, OP, TAG } from "../src/ipp/codec.js";
import { receivedMediaType } from "../src/handlers.js";
import { jobGroup, operationGroup, pdfOf, startHarness, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const print = (...jobAttrs: ReturnType<typeof attr>[]) => ({
  code: OP.printJob,
  groups: [
    operationGroup(
      attr(TAG.uri, "printer-uri", `https://${h.host}/ipp/print`),
      attr(TAG.name, "requesting-user-name", "Alex"),
      attr(TAG.name, "job-name", "Doc"),
      attr(TAG.mime, "document-format", "application/pdf"),
    ),
    jobGroup(...jobAttrs),
  ],
});

describe("job_received logging for real-device checks", () => {
  it("records the attribute names and a top-level media-type, and nothing else new", async () => {
    await h.ipp(print(attr(TAG.integer, "copies", 1), attr(TAG.name, "media-type", "Booklet - right edge, stapled")), pdfOf("log-a"));
    const e = h.web.events.find((x) => x.type === "job_received")!;
    expect(e.detail).toMatchObject({ mediaType: "Booklet - right edge, stapled" });
    expect(e.detail!.attributeNames).toEqual(expect.arrayContaining(["copies", "media-type"]));
    expect(Object.keys(e.detail!).sort()).toEqual(["attributeNames", "documentFormat", "jobName", "mediaType", "sizeBytes"]);
  });

  it("is null when the client sent no media-type", async () => {
    await h.ipp(print(attr(TAG.integer, "copies", 1)), pdfOf("log-b"));
    expect(h.web.events.find((x) => x.type === "job_received")!.detail!.mediaType).toBeNull();
  });

  it("reads the media-type inside media-col", () => {
    expect(receivedMediaType({ "media-col": { "media-type": "cardstock" } })).toBe("cardstock");
  });
});

describe("dedupe", () => {
  it("the same PDF with a different paper type (preset) is a different job", async () => {
    const { dedupeKey } = await import("../src/handlers.js");
    const doc = pdfOf("dd");
    expect(dedupeKey("d", doc, { "media-type": "2 pages per sheet" })).not.toBe(dedupeKey("d", doc, { "media-type": "stationery" }));
  });
});
