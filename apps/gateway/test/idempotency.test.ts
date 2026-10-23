// Phone retries must not create duplicate jobs (owner decision 2026-10-23), and the 1-per-second Android poll must
// not become a web request per poll. Real http server + fake web + fake storage (test/helpers.ts).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attr, OP, STATUS, TAG, type IppAttr } from "../src/ipp/codec.js";
import { flatGroup, jobGroup, operationGroup, pdfOf, startHarness, type Harness } from "./helpers.js";

let h: Harness;
let clock = 1_000_000;
beforeEach(async () => {
  clock = 1_000_000;
  h = await startHarness({ now: () => clock });
});
afterEach(async () => {
  await h.close();
});

const printerUri = () => attr(TAG.uri, "printer-uri", `https://${h.host}/ipp/print`);
const user = (n = "Alex") => attr(TAG.name, "requesting-user-name", n);

const printJob = (opts: { name?: string; copies?: number; sides?: string } = {}) => ({
  code: OP.printJob,
  groups: [
    operationGroup(printerUri(), user("pixel"), attr(TAG.name, "job-name", opts.name ?? "boarding pass.pdf"), attr(TAG.mime, "document-format", "application/pdf")),
    jobGroup(
      attr(TAG.integer, "copies", opts.copies ?? 1),
      attr(TAG.keyword, "sides", opts.sides ?? "one-sided"),
      attr(TAG.keyword, "media", "na_letter_8.5x11in"),
      // A per-attempt value that differs between retries must NOT defeat the de-duplication.
      attr(TAG.name, "job-uuid", `urn:uuid:${Math.random()}`),
    ),
  ],
});
const createJob = () => ({ code: OP.createJob, groups: [operationGroup(printerUri(), user(), attr(TAG.name, "job-name", "Report")), jobGroup(attr(TAG.integer, "copies", 1))] });
const sendDoc = (jobId: number) => ({
  code: OP.sendDocument,
  groups: [operationGroup(printerUri(), attr(TAG.integer, "job-id", jobId), user(), attr(TAG.mime, "document-format", "application/pdf"), attr(TAG.boolean, "last-document", true))],
});
const getAttrs = (jobId: number, extra: IppAttr[] = []) => ({
  code: OP.getJobAttributes,
  groups: [operationGroup(printerUri(), attr(TAG.integer, "job-id", jobId), ...extra)],
});
const jobIdOf = (m: { groups: Parameters<typeof flatGroup>[0]["groups"] }) => flatGroup(m as never, TAG.job)["job-id"] as number;

describe("duplicate protection: the same device sending the same document again", () => {
  it("sequential retry within the window returns the same job: one upload, one web job, a normal success", async () => {
    const doc = pdfOf("retry-me");
    const first = await h.ipp(printJob(), doc);
    const second = await h.ipp(printJob(), doc);
    expect(first.ipp.code).toBe(STATUS.ok);
    expect(second.ipp.code).toBe(STATUS.ok);
    expect(h.web.finalizeCalls).toHaveLength(1);
    expect(h.storage.uploads.size).toBe(1);
    expect(jobIdOf(second.ipp)).toBe(jobIdOf(first.ipp));
    // it looks like any success: same state words
    expect(flatGroup(second.ipp, TAG.job)["job-state"]).toBe(flatGroup(first.ipp, TAG.job)["job-state"]);
    expect(flatGroup(second.ipp, TAG.job)["job-state-message"]).toBe(flatGroup(first.ipp, TAG.job)["job-state-message"]);
    expect(h.web.events.filter((e) => e.type === "job_received")).toHaveLength(1);
    expect(h.web.events.some((e) => e.type === "info" && (e.detail as { reason?: string })?.reason === "duplicate_submission")).toBe(true);
  });

  it("a deliberate reprint after the first job COMPLETED is a new job (never swallowed), even within seconds", async () => {
    const doc = pdfOf("print-it-again");
    const first = await h.ipp(printJob(), doc);
    h.web.jobs.set("web-job-1", { jobId: "web-job-1", status: "completed" });
    const second = await h.ipp(printJob(), doc); // no clock movement: the lookup must be fresh, not the 3 s cache
    expect(second.ipp.code).toBe(STATUS.ok);
    expect(h.web.finalizeCalls).toHaveLength(2);
    expect(jobIdOf(second.ipp)).not.toBe(jobIdOf(first.ipp));
    // and the new job is now the remembered one
    const third = await h.ipp(printJob(), doc);
    expect(jobIdOf(third.ipp)).toBe(jobIdOf(second.ipp));
    expect(h.web.finalizeCalls).toHaveLength(2);
  });

  it.each(["failed", "cancelled", "denied", "rejected", "expired"] as const)("a repeat after the first job ended as %s is a new job", async (status) => {
    const doc = pdfOf(`ended-${status}`);
    await h.ipp(printJob(), doc);
    h.web.jobs.set("web-job-1", { jobId: "web-job-1", status });
    await h.ipp(printJob(), doc);
    expect(h.web.finalizeCalls).toHaveLength(2);
  });

  it.each(["pending_approval", "held", "approved", "claimed", "downloading", "downloaded", "printing", "submitted_to_spooler"] as const)(
    "a repeat while the first job is still %s (genuinely in flight) is the same job",
    async (status) => {
      const doc = pdfOf(`inflight-${status}`);
      const first = await h.ipp(printJob(), doc);
      h.web.jobs.set("web-job-1", { jobId: "web-job-1", status });
      const second = await h.ipp(printJob(), doc);
      expect(h.web.finalizeCalls).toHaveLength(1);
      expect(jobIdOf(second.ipp)).toBe(jobIdOf(first.ipp));
    },
  );

  it("if the status lookup fails, the repeat is NOT deduplicated: a rare duplicate beats a lost print", async () => {
    const doc = pdfOf("lookup-fails");
    await h.ipp(printJob(), doc);
    h.web.getJobDown = true;
    const second = await h.ipp(printJob(), doc);
    expect(second.ipp.code).toBe(STATUS.ok);
    expect(h.web.finalizeCalls).toHaveLength(2);
  });

  it("if the earlier job can no longer be found, the repeat is a new job", async () => {
    const doc = pdfOf("vanished");
    await h.ipp(printJob(), doc);
    h.web.jobs.delete("web-job-1");
    await h.ipp(printJob(), doc);
    expect(h.web.finalizeCalls).toHaveLength(2);
  });

  it("concurrent identical requests share ONE finalize and get the same job", async () => {
    let open!: () => void;
    h.web.finalizeGate = new Promise<void>((r) => (open = r));
    const doc = pdfOf("double-tap");
    const a = h.ipp(printJob(), doc);
    const b = h.ipp(printJob(), doc);
    const c = h.ipp(printJob(), doc);
    await new Promise((r) => setTimeout(r, 150));
    expect(h.web.finalizeInFlight).toBe(1);
    open();
    const all = await Promise.all([a, b, c]);
    expect(all.map((r) => r.ipp.code)).toEqual([STATUS.ok, STATUS.ok, STATUS.ok]);
    expect(h.web.finalizeCalls).toHaveLength(1);
    expect(h.storage.uploads.size).toBe(1);
    expect(new Set(all.map((r) => jobIdOf(r.ipp))).size).toBe(1);
  });

  it("a different document is a different job", async () => {
    await h.ipp(printJob(), pdfOf("one"));
    await h.ipp(printJob(), pdfOf("two"));
    expect(h.web.finalizeCalls).toHaveLength(2);
  });

  it("the same document with different print options (30 copies instead of 1) is a different job", async () => {
    const doc = pdfOf("same-bytes");
    await h.ipp(printJob({ copies: 1 }), doc);
    await h.ipp(printJob({ copies: 30 }), doc);
    await h.ipp(printJob({ copies: 30, sides: "two-sided-long-edge" }), doc);
    expect(h.web.finalizeCalls).toHaveLength(3);
  });

  it("another device sending the same bytes is never deduplicated against this one", async () => {
    const other = h.addDevice("dev-2");
    const doc = pdfOf("shared-handout");
    await h.ipp(printJob(), doc);
    await h.ipp(printJob(), doc, { host: other.host });
    expect(h.web.finalizeCalls).toHaveLength(2);
    expect(h.web.finalizeCalls.map((c) => c.deviceId).sort()).toEqual(["dev-1", "dev-2"]);
  });

  it("the window is about 3 minutes: after that the same document is a new print", async () => {
    const doc = pdfOf("later");
    await h.ipp(printJob(), doc);
    clock += 2 * 60_000 + 59_000;
    await h.ipp(printJob(), doc);
    expect(h.web.finalizeCalls).toHaveLength(1);
    clock += 2_000;
    await h.ipp(printJob(), doc);
    expect(h.web.finalizeCalls).toHaveLength(2);
  });

  it("a failed web call does not poison it: the retry goes through and creates exactly one job; later retries dedupe", async () => {
    const doc = pdfOf("flaky");
    h.web.finalizeDown = true;
    const failed = await h.ipp(printJob(), doc);
    expect(failed.ipp.code).toBe(STATUS.temporaryError);
    h.web.finalizeDown = false;
    const retry = await h.ipp(printJob(), doc);
    expect(retry.ipp.code).toBe(STATUS.ok);
    const again = await h.ipp(printJob(), doc);
    expect(jobIdOf(again.ipp)).toBe(jobIdOf(retry.ipp));
    expect(h.web.finalizeCalls).toHaveLength(1);
  });

  it("a storage failure does not poison it either", async () => {
    const doc = pdfOf("storage-flaky");
    h.storage.fail = true;
    expect((await h.ipp(printJob(), doc)).ipp.code).toBe(STATUS.temporaryError);
    h.storage.fail = false;
    expect((await h.ipp(printJob(), doc)).ipp.code).toBe(STATUS.ok);
    expect(h.web.finalizeCalls).toHaveLength(1);
  });

  it("concurrent identical requests where the web call fails: all get the temporary error, the next retry works", async () => {
    let open!: () => void;
    h.web.finalizeGate = new Promise<void>((r) => (open = r));
    h.web.failAfterCreating = true;
    const doc = pdfOf("both-fail");
    const a = h.ipp(printJob(), doc);
    const b = h.ipp(printJob(), doc);
    await new Promise((r) => setTimeout(r, 150));
    open();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.ipp.code, rb.ipp.code]).toEqual([STATUS.temporaryError, STATUS.temporaryError]);
    h.web.finalizeGate = null;
    expect((await h.ipp(printJob(), doc)).ipp.code).toBe(STATUS.ok);
  });

  it("a refusal (bad PDF / quota) is not remembered: the retry asks the web app again", async () => {
    const doc = pdfOf("refused");
    h.web.finalizeResult = { kind: "refused", reason: "quota_exceeded" };
    expect((await h.ipp(printJob(), doc)).ipp.code).toBe(STATUS.notPossible);
    h.web.finalizeResult = null;
    expect((await h.ipp(printJob(), doc)).ipp.code).toBe(STATUS.ok);
    expect(h.web.finalizeCalls).toHaveLength(2);
  });

  it("a job that was cancelled is not handed back for the same document: it prints as a new job", async () => {
    const doc = pdfOf("changed-my-mind");
    const first = await h.ipp(printJob(), doc);
    const cancel = await h.ipp({ code: OP.cancelJob, groups: [operationGroup(printerUri(), attr(TAG.integer, "job-id", jobIdOf(first.ipp)))] });
    expect(cancel.ipp.code).toBe(STATUS.ok);
    const second = await h.ipp(printJob(), doc);
    expect(second.ipp.code).toBe(STATUS.ok);
    expect(h.web.finalizeCalls).toHaveLength(2);
    expect(jobIdOf(second.ipp)).not.toBe(jobIdOf(first.ipp));
  });

  it("Windows flow: a second Create-Job + Send-Document of the same document resolves to the same web job under its own job id", async () => {
    const doc = pdfOf("windows-doc");
    const cj1 = jobIdOf((await h.ipp(createJob())).ipp);
    const s1 = await h.ipp(sendDoc(cj1), doc);
    const cj2 = jobIdOf((await h.ipp(createJob())).ipp);
    const s2 = await h.ipp(sendDoc(cj2), doc);
    expect(s1.ipp.code).toBe(STATUS.ok);
    expect(s2.ipp.code).toBe(STATUS.ok);
    expect(cj2).not.toBe(cj1);
    expect(jobIdOf(s2.ipp)).toBe(cj2);
    expect(h.web.finalizeCalls).toHaveLength(1);
    // the second id works for polling and points at the same web job
    const polled = await h.ipp(getAttrs(cj2));
    expect(polled.ipp.code).toBe(STATUS.ok);
    expect(h.registry.get("dev-1", cj2)?.webJobId).toBe(h.registry.get("dev-1", cj1)?.webJobId);
  });

  it("a finalize that created the job but timed out: the retry is a fresh attempt (known gap, see the contract)", async () => {
    // Nothing on the web side can tell us the first attempt succeeded (no idempotency key / hash column without a
    // migration), so this case is NOT covered; this test pins the current, documented behaviour.
    const doc = pdfOf("created-then-timeout");
    h.web.failAfterCreating = true;
    expect((await h.ipp(printJob(), doc)).ipp.code).toBe(STATUS.temporaryError);
    expect((await h.ipp(printJob(), doc)).ipp.code).toBe(STATUS.ok);
    expect(h.web.finalizeCalls).toHaveLength(2);
  });
});

describe("status cache: Android's 1-per-second Get-Job-Attributes", () => {
  it("ten polls in a few seconds cost one web call; the cache expires after ~3 s", async () => {
    const sent = await h.ipp(printJob(), pdfOf("poll-me"));
    const id = jobIdOf(sent.ipp);
    // The finalize answer primed the cache, so even the first poll is free.
    const before = h.web.getJobCalls;
    for (let i = 0; i < 10; i += 1) {
      const r = await h.ipp(getAttrs(id));
      expect(r.ipp.code).toBe(STATUS.ok);
      clock += 200;
    }
    expect(h.web.getJobCalls - before).toBeLessThanOrEqual(1);
    // the web app moves the job along; the phone sees it within the TTL
    h.web.jobs.set("web-job-1", { jobId: "web-job-1", status: "printing" });
    clock += 3_100;
    const r = await h.ipp(getAttrs(id));
    expect(flatGroup(r.ipp, TAG.job)["job-state"]).toBe(5);
  });

  it("a finished job is never asked about again", async () => {
    const sent = await h.ipp(printJob(), pdfOf("done-soon"));
    const id = jobIdOf(sent.ipp);
    h.web.jobs.set("web-job-1", { jobId: "web-job-1", status: "completed" });
    clock += 5_000;
    await h.ipp(getAttrs(id));
    const calls = h.web.getJobCalls;
    for (let i = 0; i < 5; i += 1) {
      clock += 10_000;
      const r = await h.ipp(getAttrs(id));
      expect(flatGroup(r.ipp, TAG.job)["job-state"]).toBe(9);
    }
    expect(h.web.getJobCalls).toBe(calls);
  });

  it("Cancel-Job shows up immediately in the next poll (cache invalidated)", async () => {
    const sent = await h.ipp(printJob(), pdfOf("cancel-me"));
    const id = jobIdOf(sent.ipp);
    await h.ipp(getAttrs(id)); // cached as approved
    const cancel = await h.ipp({ code: OP.cancelJob, groups: [operationGroup(printerUri(), attr(TAG.integer, "job-id", id))] });
    expect(cancel.ipp.code).toBe(STATUS.ok);
    const r = await h.ipp(getAttrs(id));
    expect(flatGroup(r.ipp, TAG.job)["job-state"]).toBe(7);
  });

  it("many concurrent polls for one job (Get-Jobs + Get-Job-Attributes from several phones of one user) make one call", async () => {
    const sent = await h.ipp(printJob(), pdfOf("many-polls"));
    const id = jobIdOf(sent.ipp);
    clock += 10_000; // expire the primed value
    const before = h.web.getJobCalls;
    await Promise.all(Array.from({ length: 8 }, () => h.ipp(getAttrs(id))));
    expect(h.web.getJobCalls - before).toBeLessThanOrEqual(1);
  });
});

describe("waiting for the printer, as the phone sees it", () => {
  it("a queued job the web app says is waiting shows 'Waiting for the printer' (and why, for the kind we know)", async () => {
    h.web.nextStatus = "approved";
    const sent = await h.ipp(printJob(), pdfOf("printer-off"));
    const id = jobIdOf(sent.ipp);
    h.web.jobs.set("web-job-1", { jobId: "web-job-1", status: "approved", message: "The printer is not available right now (off, offline or network). It will print when it is back.", waiting: "unavailable" });
    clock += 5_000;
    const r = await h.ipp(getAttrs(id));
    const j = flatGroup(r.ipp, TAG.job);
    expect(j["job-state"]).toBe(3);
    expect(String(j["job-state-message"])).toMatch(/^Waiting for the printer/);
    expect(String(j["job-state-message"])).toMatch(/off or offline|not available/i);
    expect(String(j["job-state-message"]).length).toBeLessThan(100);
  });

  it("the unknown kind says 'status unknown'", async () => {
    await h.ipp(printJob(), pdfOf("who-knows"));
    h.web.jobs.set("web-job-1", { jobId: "web-job-1", status: "approved", message: "Waiting for the printer - status unknown", waiting: "unknown" });
    clock += 5_000;
    const r = await h.ipp(getAttrs(h.registry.list("dev-1")[0]!.ippId));
    expect(flatGroup(r.ipp, TAG.job)["job-state-message"]).toBe("Waiting for the printer - status unknown");
  });

  it("an ordinary queued job still just says 'Waiting for the printer'", async () => {
    const sent = await h.ipp(printJob(), pdfOf("normal"));
    expect(flatGroup(sent.ipp, TAG.job)["job-state-message"]).toBe("Waiting for the printer");
  });
});
