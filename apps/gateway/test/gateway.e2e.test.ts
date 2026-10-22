// End-to-end: real http server + fake web API + fake storage. Request shapes replay what Windows 11 and Android
// sent in the Phase 0 spike (docs/ipp-printing.md, tools/ipp-spike/spike.test.mjs).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_STATES } from "@printio/shared";
import { hashDeviceToken } from "@printio/shared/device-token";
import { attr, encodeIpp, OP, STATUS, TAG, type IppAttr } from "../src/ipp/codec.js";
import { mapJobState } from "../src/handlers.js";
import { flatGroup, jobGroup, operationGroup, PDF, startHarness, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const printerUri = () => attr(TAG.uri, "printer-uri", `https://${h.host}/ipp/print`);
const user = (n = "Alex") => attr(TAG.name, "requesting-user-name", n);
const letterMediaCol: IppAttr = attr(TAG.begCollection, "media-col", [
  {
    name: "media-size",
    tag: TAG.begCollection,
    values: [[
      { name: "x-dimension", tag: TAG.integer, values: [21590] },
      { name: "y-dimension", tag: TAG.integer, values: [27940] },
    ]],
  },
  { name: "media-type", tag: TAG.keyword, values: ["stationery"] },
]);

const windowsCreate = (name = "Quarterly Report") => ({
  code: OP.createJob,
  groups: [
    operationGroup(printerUri(), user(), attr(TAG.name, "job-name", name)),
    jobGroup(
      attr(TAG.integer, "copies", 1),
      attr(TAG.keyword, "sides", "two-sided-long-edge"),
      letterMediaCol,
      attr(TAG.enum, "finishings", 3),
      attr(TAG.keyword, "print-color-mode", "monochrome"),
      attr(TAG.enum, "orientation-requested", 3),
    ),
  ],
});
const windowsSend = (jobId: number) => ({
  code: OP.sendDocument,
  groups: [
    operationGroup(
      printerUri(),
      attr(TAG.integer, "job-id", jobId),
      user(),
      attr(TAG.mime, "document-format", "application/pdf"),
      attr(TAG.boolean, "last-document", true),
    ),
  ],
});
const androidPrint = (doc = "application/pdf") => ({
  code: OP.printJob,
  groups: [
    operationGroup(printerUri(), user("pixel"), attr(TAG.name, "job-name", "boarding pass.pdf"), attr(TAG.mime, "document-format", doc)),
    jobGroup(
      attr(TAG.integer, "copies", 2),
      attr(TAG.keyword, "sides", "one-sided"),
      attr(TAG.range, "page-ranges", [1, 3]),
      attr(TAG.keyword, "media", "na_letter_8.5x11in"),
      attr(TAG.enum, "print-quality", 4),
    ),
  ],
});

describe("Windows 11 flow", () => {
  it("Get-Printer-Attributes on an arbitrary path honours requested-attributes and records one event", async () => {
    const r = await h.ipp(
      {
        code: OP.getPrinterAttributes,
        groups: [operationGroup(printerUri(), attr(TAG.keyword, "requested-attributes", "printer-name", "finishings-supported", "document-format-supported"))],
      },
      Buffer.alloc(0),
      { path: "/whatever/the/user/pasted" },
    );
    expect(r.http.status).toBe(200);
    expect(r.http.headers["content-type"]).toBe("application/ipp");
    expect(r.ipp.code).toBe(STATUS.ok);
    const p = flatGroup(r.ipp, TAG.printer);
    expect(Object.keys(p).sort()).toEqual(["document-format-supported", "finishings-supported", "printer-name"]);
    expect(p["finishings-supported"]).toEqual([3, 4, 20, 22, 8, 13]);
    expect(flatGroup(r.ipp, TAG.operation)["attributes-charset"]).toBe("utf-8");
    // advertised URI follows Host (+ X-Forwarded-Proto, default http)
    const all = await h.ipp({ code: OP.getPrinterAttributes, groups: [operationGroup(printerUri())] }, Buffer.alloc(0), {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(flatGroup(all.ipp, TAG.printer)["printer-uri-supported"]).toBe(`https://${h.host}/ipp/print`);
    // throttled: two requests inside a minute -> one event
    await vi.waitFor(() => expect(h.web.events.filter((e) => e.type === "attributes_requested")).toHaveLength(1));
    expect(h.web.events[0]).toMatchObject({ deviceId: "dev-1", userAgent: "test-client" });
  });

  it("Create-Job holds, Send-Document uploads + finalizes with the flattened attributes, reply keeps the Create-Job id", async () => {
    const created = await h.ipp(windowsCreate());
    expect(created.ipp.code).toBe(STATUS.ok);
    const cj = flatGroup(created.ipp, TAG.job);
    expect(cj["job-state"]).toBe(4);
    expect(cj["job-state-reasons"]).toBe("job-incoming");
    expect(h.storage.uploads.size).toBe(0);
    expect(h.web.finalizeCalls).toHaveLength(0);

    h.web.nextStatus = "held";
    h.web.nextMessage = "Staple is not available from the print dialog yet.";
    const sent = await h.ipp(windowsSend(cj["job-id"] as number), PDF, { chunked: true });
    expect(sent.ipp.code).toBe(STATUS.ok);

    // upload
    expect(h.storage.uploads.size).toBe(1);
    const [path, bytes] = [...h.storage.uploads.entries()][0] as [string, Buffer];
    expect(path).toMatch(/^gateway-intake\/dev-1\/[0-9a-f-]{36}\.pdf$/);
    expect(bytes.equals(PDF)).toBe(true);

    // finalize payload
    expect(h.web.finalizeCalls).toHaveLength(1);
    expect(h.web.finalizeCalls[0]).toEqual({
      deviceId: "dev-1",
      storagePath: path,
      fileName: "Quarterly Report.pdf",
      sizeBytes: PDF.length,
      ipp: {
        jobName: "Quarterly Report",
        userAgent: "test-client",
        ippVersion: "2.0",
        attributes: {
          copies: 1,
          sides: "two-sided-long-edge",
          "media-col": { "media-size": { "x-dimension": 21590, "y-dimension": 27940 }, "media-type": "stationery" },
          finishings: 3,
          "print-color-mode": "monochrome",
          "orientation-requested": 3,
          "document-format": "application/pdf",
        },
      },
    });

    // reply
    const sj = flatGroup(sent.ipp, TAG.job);
    expect(sj["job-id"]).toBe(cj["job-id"]);
    expect(sj["job-state"]).toBe(4);
    expect(sj["job-state-reasons"]).toBe("job-hold-until-specified");
    expect(sj["job-state-message"]).toBe("Staple is not available from the print dialog yet.");
    expect(h.web.events.map((e) => e.type)).toContain("job_received");

    // Windows polls the job afterwards; the web moves it along
    h.web.jobs.set("web-job-1", { jobId: "web-job-1", status: "completed" });
    const polled = await h.ipp({
      code: OP.getJobAttributes,
      groups: [operationGroup(printerUri(), attr(TAG.integer, "job-id", cj["job-id"] as number))],
    });
    const pj = flatGroup(polled.ipp, TAG.job);
    expect(pj["job-state"]).toBe(9);
    expect(pj["job-state-reasons"]).toBe("job-completed-successfully");
    expect(pj["job-state-message"]).toBeUndefined();

    // ... and by job-uri
    const byUri = await h.ipp({
      code: OP.getJobAttributes,
      groups: [operationGroup(printerUri(), attr(TAG.uri, "job-uri", pj["job-uri"] as string))],
    });
    expect(flatGroup(byUri.ipp, TAG.job)["job-id"]).toBe(cj["job-id"]);

    const completed = await h.ipp({ code: OP.getJobs, groups: [operationGroup(printerUri(), attr(TAG.keyword, "which-jobs", "completed"))] });
    expect(completed.ipp.groups.filter((g) => g.tag === TAG.job)).toHaveLength(1);
    const active = await h.ipp({ code: OP.getJobs, groups: [operationGroup(printerUri())] });
    expect(active.ipp.groups.filter((g) => g.tag === TAG.job)).toHaveLength(0);
  });

  it("Send-Document for an unknown or expired Create-Job is not-found", async () => {
    let t = 1_000_000;
    await h.close();
    h = await startHarness({ now: () => t });
    const cj = flatGroup((await h.ipp(windowsCreate())).ipp, TAG.job);
    t += 10 * 60 * 1000 + 1;
    const late = await h.ipp(windowsSend(cj["job-id"] as number), PDF);
    expect(late.ipp.code).toBe(STATUS.notFound);
    const never = await h.ipp(windowsSend(77), PDF);
    expect(never.ipp.code).toBe(STATUS.notFound);
    expect(h.storage.uploads.size).toBe(0);
  });

  it("Send-Document twice for one job is refused the second time", async () => {
    const cj = flatGroup((await h.ipp(windowsCreate())).ipp, TAG.job);
    expect((await h.ipp(windowsSend(cj["job-id"] as number), PDF)).ipp.code).toBe(STATUS.ok);
    expect((await h.ipp(windowsSend(cj["job-id"] as number), PDF)).ipp.code).toBe(STATUS.notPossible);
    expect(h.web.finalizeCalls).toHaveLength(1);
  });
});

describe("Android flow", () => {
  it("Validate-Job then Print-Job (single request, flattened attributes, id = web job number)", async () => {
    const v = await h.ipp({
      code: OP.validateJob,
      groups: [operationGroup(printerUri(), user("pixel"), attr(TAG.mime, "document-format", "application/pdf"))],
    });
    expect(v.ipp.code).toBe(STATUS.ok);

    h.web.nextStatus = "approved";
    const r = await h.ipp(androidPrint(), PDF);
    expect(r.ipp.code).toBe(STATUS.ok);
    const j = flatGroup(r.ipp, TAG.job);
    expect(j["job-id"]).toBe(41);
    expect(j["job-state"]).toBe(3);
    expect(j["job-state-reasons"]).toBe("job-queued");
    expect(j["job-name"]).toBe("boarding pass.pdf");

    expect(h.storage.uploads.size).toBe(1);
    const call = h.web.finalizeCalls[0]!;
    expect(call.fileName).toBe("boarding pass.pdf");
    expect(call.ipp.attributes).toEqual({
      copies: 2,
      sides: "one-sided",
      "page-ranges": [1, 3],
      media: "na_letter_8.5x11in",
      "print-quality": 4,
      "document-format": "application/pdf",
    });
    expect(h.web.events.map((e) => e.type)).toEqual(["job_received"]);
  });

  it("every JobState maps to the contract's IPP state and reasons in a real reply", async () => {
    for (const state of JOB_STATES) {
      h.web.nextStatus = state;
      const r = await h.ipp(androidPrint(), PDF);
      const j = flatGroup(r.ipp, TAG.job);
      const want = mapJobState(state);
      expect([state, j["job-state"], j["job-state-reasons"]]).toEqual([state, want.state, want.reason]);
    }
  });
});

describe("negative paths", () => {
  it("a host that is not a device hostname gets a bare 404 for everything", async () => {
    for (const host of ["localhost:8631", "example.test", "u-short.example.test", "random.other.org"]) {
      const r = await h.post(encodeIpp({ code: OP.getPrinterAttributes, requestId: 1, groups: [operationGroup()] }), { host });
      expect(r.status).toBe(404);
      expect(r.body.toString()).toBe("not found");
    }
    const get = await h.post(Buffer.alloc(0), { method: "GET" });
    expect(get.status).toBe(404);
    expect(h.web.resolveCalls).toBe(0);
  });

  it("a token-shaped but unknown device: 404 for Get-Printer-Attributes (no leak), 0x0401 for jobs", async () => {
    h.web.devices.clear();
    const gpa = await h.post(encodeIpp({ code: OP.getPrinterAttributes, requestId: 1, groups: [operationGroup(printerUri())] }));
    expect(gpa.status).toBe(404);
    expect(gpa.body.toString()).toBe("not found");
    const job = await h.ipp(androidPrint(), PDF);
    expect(job.http.status).toBe(200);
    expect(job.ipp.code).toBe(STATUS.notAuthorized);
    expect(h.storage.uploads.size).toBe(0);
  });

  it("revoked or inactive device -> 0x0401 with a readable message, nothing stored", async () => {
    h.web.devices.set(hashDeviceToken(h.token), { kind: "revoked" });
    const revoked = await h.ipp(androidPrint(), PDF);
    expect(revoked.ipp.code).toBe(STATUS.notAuthorized);
    expect(flatGroup(revoked.ipp, TAG.operation)["status-message"]).toMatch(/removed/);
    expect((await h.ipp({ code: OP.getPrinterAttributes, groups: [operationGroup(printerUri())] })).ipp.code).toBe(STATUS.notAuthorized);
    h.web.devices.set(hashDeviceToken(h.token), { kind: "inactive_member" });
    expect((await h.ipp(windowsCreate())).ipp.code).toBe(STATUS.notAuthorized);
    expect(h.storage.uploads.size).toBe(0);
    expect(h.web.finalizeCalls).toHaveLength(0);
  });

  it("non-PDF document-format -> 0x040A, a job_rejected event, no upload", async () => {
    const r = await h.ipp(androidPrint("image/jpeg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    expect(r.ipp.code).toBe(STATUS.documentFormatNotSupported);
    expect(h.storage.uploads.size).toBe(0);
    expect(h.web.finalizeCalls).toHaveLength(0);
    expect(h.web.events).toHaveLength(1);
    expect(h.web.events[0]).toMatchObject({ type: "job_rejected", detail: { reason: "unsupported_document_format", documentFormat: "image/jpeg" } });
    // Validate-Job says no up front as well
    const v = await h.ipp({ code: OP.validateJob, groups: [operationGroup(printerUri(), attr(TAG.mime, "document-format", "image/pwg-raster"))] });
    expect(v.ipp.code).toBe(STATUS.documentFormatNotSupported);
  });

  it("octet-stream is accepted only when the bytes really are a PDF", async () => {
    const ok = await h.ipp(androidPrint("application/octet-stream"), PDF);
    expect(ok.ipp.code).toBe(STATUS.ok);
    const bad = await h.ipp(androidPrint("application/octet-stream"), Buffer.from("MZ not a pdf"));
    expect(bad.ipp.code).toBe(STATUS.documentFormatNotSupported);
  });

  it("empty Print-Job -> bad request", async () => {
    const r = await h.ipp(androidPrint(), Buffer.alloc(0));
    expect(r.ipp.code).toBe(STATUS.badRequest);
  });

  it("web down at resolve -> 0x0506 for every operation", async () => {
    h.web.down = true;
    for (const code of [OP.getPrinterAttributes, OP.validateJob, OP.createJob]) {
      const r = await h.ipp({ code, groups: [operationGroup(printerUri())] });
      expect(r.http.status).toBe(200);
      expect(r.ipp.code).toBe(STATUS.temporaryError);
    }
    const p = await h.ipp(androidPrint(), PDF);
    expect(p.ipp.code).toBe(STATUS.temporaryError);
  });

  it("web 5xx on finalize -> 0x0506 and the PDF stays in storage (not silently dropped)", async () => {
    h.web.finalizeDown = true;
    const r = await h.ipp(androidPrint(), PDF);
    expect(r.ipp.code).toBe(STATUS.temporaryError);
    expect(h.storage.uploads.size).toBe(1);
    expect([...h.storage.uploads.values()][0]!.equals(PDF)).toBe(true);
    // the client retries when the web is back and gets a job
    h.web.finalizeDown = false;
    const again = await h.ipp(androidPrint(), PDF);
    expect(again.ipp.code).toBe(STATUS.ok);
  });

  it("storage failure -> 0x0506 and no finalize", async () => {
    h.storage.fail = true;
    const r = await h.ipp(androidPrint(), PDF);
    expect(r.ipp.code).toBe(STATUS.temporaryError);
    expect(h.web.finalizeCalls).toHaveLength(0);
  });

  it("422 bad_pdf from the web -> client error, a job_rejected event, no job remembered", async () => {
    h.web.finalizeResult = { kind: "bad_pdf", message: "The PDF is password protected." };
    const r = await h.ipp(androidPrint(), PDF);
    expect(r.ipp.code).toBe(STATUS.documentFormatError);
    expect(flatGroup(r.ipp, TAG.operation)["status-message"]).toBe("The PDF is password protected.");
    expect(h.web.events.map((e) => e.type)).toEqual(["job_received", "job_rejected"]);
    expect(h.registry.list("dev-1")).toHaveLength(0);
  });

  it("quota refusal -> permanent client error with the readable message, job_rejected event, nothing remembered", async () => {
    h.web.finalizeResult = { kind: "refused", reason: "quota_exceeded", message: "Monthly quota used up." };
    const r = await h.ipp(androidPrint(), PDF);
    expect(r.ipp.code).toBe(STATUS.notPossible);
    expect(flatGroup(r.ipp, TAG.operation)["status-message"]).toBe("Monthly quota used up.");
    expect(h.web.events.map((e) => e.type)).toEqual(["job_received", "job_rejected"]);
    expect(h.registry.list("dev-1")).toHaveLength(0);
  });

  it("rate limit refusal -> client error (not 0x0506) with a default message", async () => {
    h.web.finalizeResult = { kind: "refused", reason: "rate_limited" };
    const r = await h.ipp(androidPrint(), PDF);
    expect(r.ipp.code).toBe(STATUS.notPossible);
    expect(String(flatGroup(r.ipp, TAG.operation)["status-message"])).toMatch(/too many|wait/i);
  });

  it("oversized body -> clean IPP 0x0408, nothing stored, server keeps serving", async () => {
    await h.close();
    h = await startHarness({ maxBodyBytes: 4096 });
    const big = Buffer.concat([PDF, Buffer.alloc(10_000, 0x41)]);
    const r = await h.ipp(androidPrint(), big);
    expect(r.http.status).toBe(200);
    expect(r.ipp.code).toBe(STATUS.requestEntityTooLarge);
    expect(h.storage.uploads.size).toBe(0);
    // chunked variant
    const c = await h.ipp(androidPrint(), big, { chunked: true });
    expect(c.ipp.code).toBe(STATUS.requestEntityTooLarge);
    // far past the drain cap: the socket may be cut, but the process must survive
    const huge = Buffer.concat([PDF, Buffer.alloc(200_000, 0x41)]);
    await h.ipp(androidPrint(), huge).catch(() => undefined);
    expect(h.storage.uploads.size).toBe(0);
    const ok = await h.ipp(androidPrint(), PDF);
    expect(ok.ipp.code).toBe(STATUS.ok);
  });

  it("malformed IPP -> a clean IPP bad-request (never a crash) and the server keeps serving", async () => {
    for (const body of [Buffer.from("not ipp at all"), Buffer.alloc(0), Buffer.from([2, 0, 0, 11, 0, 0, 0, 1, 1, 0x47, 0xff, 0xff]), Buffer.alloc(500, 0xff)]) {
      const r = await h.post(body);
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toBe("application/ipp");
      expect(r.body.readUInt16BE(2)).toBe(STATUS.badRequest);
    }
    const ok = await h.ipp({ code: OP.getPrinterAttributes, groups: [operationGroup(printerUri())] });
    expect(ok.ipp.code).toBe(STATUS.ok);
  });

  it("an unexpected exception in a handler is answered with internal-error and the process keeps serving", async () => {
    const cj = flatGroup((await h.ipp(androidPrint(), PDF)).ipp, TAG.job);
    const orig = h.web.getJob.bind(h.web);
    h.web.getJob = async () => {
      throw new Error("kaboom");
    };
    const r = await h.ipp({ code: OP.getJobAttributes, groups: [operationGroup(printerUri(), attr(TAG.integer, "job-id", cj["job-id"] as number))] });
    expect(r.ipp.code).toBe(STATUS.internalError);
    h.web.getJob = orig;
    const ok = await h.ipp({ code: OP.getPrinterAttributes, groups: [operationGroup(printerUri())] });
    expect(ok.ipp.code).toBe(STATUS.ok);
  });

  it("unsupported operations", async () => {
    const r = await h.ipp({ code: 0x0010, groups: [operationGroup(printerUri())] }); // Pause-Printer
    expect(r.ipp.code).toBe(STATUS.operationNotSupported);
  });

  it("echoes request-id and a supported IPP version; Expect: 100-continue works", async () => {
    const r = await h.ipp(
      { code: OP.getPrinterAttributes, requestId: 4242, groups: [operationGroup(printerUri())] },
      Buffer.alloc(0),
      { headers: { expect: "100-continue" } },
    );
    expect(r.ipp.requestId).toBe(4242);
    expect(r.ipp.version).toBe("2.0");
  });
});

describe("Cancel-Job", () => {
  it("cancels a Create-Job that never got its document, locally", async () => {
    const cj = flatGroup((await h.ipp(windowsCreate())).ipp, TAG.job);
    const r = await h.ipp({ code: OP.cancelJob, groups: [operationGroup(printerUri(), attr(TAG.integer, "job-id", cj["job-id"] as number))] });
    expect(r.ipp.code).toBe(STATUS.ok);
    expect(h.web.cancelCalls).toHaveLength(0);
    const send = await h.ipp(windowsSend(cj["job-id"] as number), PDF);
    expect(send.ipp.code).toBe(STATUS.notFound);
  });

  it("cancels a submitted job through the web API, and reports not-possible when the web refuses", async () => {
    h.web.nextStatus = "held";
    const j = flatGroup((await h.ipp(androidPrint(), PDF)).ipp, TAG.job);
    const cancel = () => h.ipp({ code: OP.cancelJob, groups: [operationGroup(printerUri(), attr(TAG.integer, "job-id", j["job-id"] as number))] });
    const ok = await cancel();
    expect(ok.ipp.code).toBe(STATUS.ok);
    expect(h.web.cancelCalls).toEqual(["web-job-1"]);
    const after = await h.ipp({ code: OP.getJobAttributes, groups: [operationGroup(printerUri(), attr(TAG.integer, "job-id", j["job-id"] as number))] });
    expect(flatGroup(after.ipp, TAG.job)["job-state"]).toBeDefined();

    h.web.cancelResult = { kind: "not_cancellable", message: "Already printing." };
    const no = await cancel();
    expect(no.ipp.code).toBe(STATUS.notPossible);
    expect(flatGroup(no.ipp, TAG.operation)["status-message"]).toBe("Already printing.");

    h.web.cancelResult = { kind: "not_found" };
    expect((await cancel()).ipp.code).toBe(STATUS.notFound);
  });

  it("unknown job -> not-found", async () => {
    const r = await h.ipp({ code: OP.cancelJob, groups: [operationGroup(printerUri(), attr(TAG.integer, "job-id", 9))] });
    expect(r.ipp.code).toBe(STATUS.notFound);
  });
});
