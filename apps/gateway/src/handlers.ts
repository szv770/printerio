// IPP operation handlers. Behaviours, error codes, events and job-state mapping follow
// docs/superpowers/specs/2026-10-22-gateway-contract.md.
import { createHash } from "node:crypto";
import { hashDeviceToken } from "@printio/shared/device-token";
import { isTerminalState, type JobState } from "@printio/shared";
import {
  attr,
  decodeIpp,
  encodeIpp,
  flatten,
  IppParseError,
  OP,
  OP_NAMES,
  STATUS,
  TAG,
  type FlatObject,
  type IppAttr,
  type IppGroup,
  type IppMessage,
} from "./ipp/codec.js";
import { buildPrinterAttributes, filterRequested } from "./ipp/printer-attributes.js";
import { describeJob, IPP_JOB_STATE } from "./job-messages.js";
import { DedupeCache } from "./dedupe-cache.js";
import { JobRegistry, type JobEntry } from "./job-registry.js";
import { StatusCache } from "./status-cache.js";
import type { Logger } from "./logger.js";
import { intakePath, type IntakeStorage } from "./storage.js";
import { WebUnavailableError, type JobInfo, type ResolvedDevice, type WebApi } from "./web-client.js";

export interface GatewayDeps {
  web: WebApi;
  storage: IntakeStorage;
  logger: Logger;
  printerName: string;
  registry: JobRegistry;
  startedAt: number;
  now?: () => number;
  /** Awaited-by-nobody background work (events); tests can drain it. */
  background?: Set<Promise<unknown>>;
  /** Phone-retry protection (same device + same document within ~3 minutes). Created on first use when absent. */
  dedupe?: DedupeCache<FinalizedJob>;
  /** ~3 s per-job web status cache. Created on first use when absent. */
  statusCache?: StatusCache;
}

/** What a finished upload+finalize attempt produced. Small on purpose: it is kept for the dedupe window. */
export type FinalizedJob =
  | { ok: true; job: JobInfo & { jobNumber: string }; bytes: number }
  | { ok: false; reply: Reply };

const runtimes = new WeakMap<GatewayDeps, { dedupe: DedupeCache<FinalizedJob>; status: StatusCache }>();
function runtime(deps: GatewayDeps): { dedupe: DedupeCache<FinalizedJob>; status: StatusCache } {
  let r = runtimes.get(deps);
  if (!r) {
    const now = () => (deps.now ?? Date.now)();
    r = { dedupe: deps.dedupe ?? new DedupeCache<FinalizedJob>({ now }), status: deps.statusCache ?? new StatusCache({ now }) };
    runtimes.set(deps, r);
  }
  return r;
}

/** The job-template attributes that change WHAT is printed. Per-attempt noise (job-uuid, timestamps, names) is left out. */
const PRINT_AFFECTING = [
  "copies",
  "sides",
  "media",
  "media-col",
  "page-ranges",
  "finishings",
  "finishings-col",
  "print-color-mode",
  "print-quality",
  "orientation-requested",
  "number-up",
  "output-bin",
  "multiple-document-handling",
  "print-scaling",
] as const;

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** deviceId + SHA-256 of the PDF bytes + the print-affecting options. Different device, document or options never collide. */
export function dedupeKey(deviceId: string, doc: Buffer, attributes: FlatObject): string {
  const picked: Record<string, unknown> = {};
  for (const k of PRINT_AFFECTING) if (attributes[k] !== undefined) picked[k] = attributes[k];
  const hash = createHash("sha256").update(doc).digest("hex");
  const opts = createHash("sha256").update(stableStringify(picked)).digest("hex").slice(0, 16);
  return `${deviceId}:${hash}:${opts}`;
}



export interface RequestContext {
  /** Device token read from the Host header. */
  token: string;
  /** e.g. https://u-<token>.szvtech.org (X-Forwarded-Proto + Host). */
  baseUrl: string;
  userAgent?: string;
}

const MAX_IPP_ATTR_GROUPS_JOBS = 25;
const ATTR_EVENT_THROTTLE_MS = 60_000;
const attrEventSeen = new WeakMap<GatewayDeps, Map<string, number>>();

// ---------- job state mapping ----------

export { IPP_JOB_STATE };

export interface IppJobState {
  state: number;
  reason: string;
}

export function mapJobState(state: JobState): IppJobState {
  const d = describeJob(state);
  return { state: d.state, reason: d.reasons[0] as string };
}

// ---------- small helpers ----------

const first = <T>(v: T | T[] | undefined): T | undefined => (Array.isArray(v) ? v[0] : v);
const asString = (v: unknown): string | undefined => {
  const x = first(v as string | string[] | undefined);
  return typeof x === "string" ? x : undefined;
};

function sanitizeFileName(jobName: string | undefined): string {
  const base = (jobName ?? "").replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9 ._-]+/g, "").trim().slice(0, 60);
  return `${base || "document"}.pdf`;
}

function isPdf(doc: Buffer): boolean {
  return doc.length >= 5 && doc.subarray(0, 5).toString("latin1") === "%PDF-";
}

/** Accept declared PDF; for octet-stream / undeclared fall back to the %PDF- magic. Everything else is rejected. */
function documentFormatAcceptable(declared: string | undefined, doc: Buffer | null): boolean {
  const f = declared?.toLowerCase().split(";")[0]?.trim();
  if (f === "application/pdf") return true;
  if (f === undefined || f === "application/octet-stream") return doc === null ? true : isPdf(doc);
  return false;
}

const SUPPORTED_VERSIONS = ["1.1", "2.0", "2.1", "2.2"];

interface Reply {
  status: number;
  message?: string;
  groups?: IppGroup[];
}

function buildReply(msg: Pick<IppMessage, "version" | "requestId">, reply: Reply): Buffer {
  const head: IppAttr[] = [
    attr(TAG.charset, "attributes-charset", "utf-8"),
    attr(TAG.language, "attributes-natural-language", "en"),
  ];
  if (reply.message) head.push(attr(TAG.text, "status-message", reply.message));
  return encodeIpp({
    version: SUPPORTED_VERSIONS.includes(msg.version) ? msg.version : "2.0",
    code: reply.status,
    requestId: msg.requestId,
    groups: [{ tag: TAG.operation, attrs: head }, ...(reply.groups ?? [])],
  });
}

/** An IPP error reply for a request that could not be decoded (or was too large). */
export function errorReply(status: number, message: string, head?: Buffer): Buffer {
  const version = head && head.length >= 2 ? `${head[0]}.${head[1]}` : "2.0";
  const requestId = head && head.length >= 8 ? head.readUInt32BE(4) : 1;
  return buildReply({ version, requestId }, { status, message });
}

function track(deps: GatewayDeps, p: Promise<unknown>): void {
  if (!deps.background) return;
  deps.background.add(p);
  void p.finally(() => deps.background?.delete(p));
}

// ---------- job attributes ----------

function jobAttributes(deps: GatewayDeps, ctx: RequestContext, e: JobEntry): IppAttr[] {
  const mapped = describeJob(e.state, e.message, e.waiting);
  const out: IppAttr[] = [
    attr(TAG.integer, "job-id", e.ippId),
    attr(TAG.uri, "job-uri", `${ctx.baseUrl}/ipp/print/jobs/${e.ippId}`),
    attr(TAG.uri, "job-printer-uri", `${ctx.baseUrl}/ipp/print`),
    attr(TAG.enum, "job-state", mapped.state),
    attr(TAG.keyword, "job-state-reasons", ...mapped.reasons),
    attr(TAG.name, "job-name", e.name),
    attr(TAG.name, "job-originating-user-name", e.userName),
    attr(TAG.integer, "job-k-octets", Math.ceil(e.bytes / 1024)),
    attr(TAG.integer, "time-at-creation", Math.max(0, Math.floor(((deps.now ?? Date.now)() - deps.startedAt) / 1000))),
  ];
  out.push(attr(TAG.text, "job-state-message", mapped.message));
  return out;
}

function requestedFilter(attrs: IppAttr[], requested: unknown): IppAttr[] {
  const r = requested as string | string[] | undefined;
  return filterRequested(attrs, r);
}

/** Pull the IPP job-id out of job-id, or the trailing segment of job-uri. */
function ippJobId(opAttrs: FlatObject): number | null {
  const id = first(opAttrs["job-id"] as number | number[] | undefined);
  if (typeof id === "number") return id;
  const uri = asString(opAttrs["job-uri"]);
  const m = uri ? /\/jobs\/(\d+)\/?$/.exec(uri) : null;
  return m ? Number(m[1]) : null;
}

async function refreshState(deps: GatewayDeps, device: ResolvedDevice, e: JobEntry): Promise<void> {
  if (!e.webJobId) return;
  // A finished job never changes again: stop asking the web app about it.
  if (e.state && isTerminalState(e.state)) return;
  // Phones poll about once a second: answer from the ~3 s cache (shared by concurrent polls of the same job).
  const webJobId = e.webJobId;
  const info = await runtime(deps).status.get(webJobId, () => deps.web.getJob(webJobId, device.deviceId));
  if (!info) return;
  e.state = info.status;
  e.message = info.message;
  e.waiting = info.waiting;
}

/** Print-Job / Send-Document success: the job attributes plus a status-message saying where the job is. */
function submittedReply(deps: GatewayDeps, ctx: RequestContext, e: JobEntry): Reply {
  return {
    status: STATUS.ok,
    message: describeJob(e.state, e.message, e.waiting).message,
    groups: [{ tag: TAG.job, attrs: jobAttributes(deps, ctx, e) }],
  };
}

// ---------- document intake (Print-Job / Send-Document) ----------

type Submitted =
  | { ok: true; entry: JobEntry }
  | { ok: false; reply: Reply };

async function submitDocument(
  deps: GatewayDeps,
  ctx: RequestContext,
  device: ResolvedDevice,
  p: {
    opAttrs: FlatObject;
    attributes: FlatObject;
    jobName: string | undefined;
    userName: string;
    doc: Buffer;
    ippVersion: string;
    pending: JobEntry | null;
  },
): Promise<Submitted> {
  const declared = asString(p.opAttrs["document-format"]);
  if (p.doc.length === 0) {
    return { ok: false, reply: { status: STATUS.badRequest, message: "No document data was sent." } };
  }
  if (!documentFormatAcceptable(declared, p.doc)) {
    await deps.web.postEvent({
      deviceId: device.deviceId,
      type: "job_rejected",
      userAgent: ctx.userAgent,
      detail: { reason: "unsupported_document_format", documentFormat: declared ?? null, sizeBytes: p.doc.length },
    });
    return {
      ok: false,
      reply: {
        status: STATUS.documentFormatNotSupported,
        message: "Only PDF documents are supported. Choose a PDF-based print path or print to PDF first.",
      },
    };
  }
  const attributes: FlatObject = { ...p.attributes, "document-format": "application/pdf" };
  const { dedupe, status: statusCache } = runtime(deps);

  // Everything from here to the finalize answer happens at most once per (device, document, options) in the
  // window: the key exists BEFORE the web call, so a retry that arrives while the first is still being processed
  // joins it instead of starting a second job. See docs/superpowers/specs/2026-10-22-gateway-contract.md.
  const key = dedupeKey(device.deviceId, p.doc, attributes);
  const { value: done, deduped } = await dedupe.run(
    key,
    () => uploadAndFinalize(deps, ctx, device, p, attributes),
    {
      cache: (v) => v.ok,
      // A hit may only hand back the earlier job while it is genuinely STILL IN FLIGHT. Ask the web app NOW (not the
      // 3 s cache): a finished job (completed, failed, cancelled, ...) means this is a deliberate reprint and must
      // print. If the lookup fails or the job is gone we cannot prove a duplicate, so we do not dedupe (a rare
      // double print is better than a lost one).
      usable: async (v) => {
        if (!v.ok) return false;
        try {
          const now = await deps.web.getJob(v.job.jobId, device.deviceId);
          if (!now) return false;
          statusCache.prime(v.job.jobId, now);
          return !isTerminalState(now.status) && now.status !== "failed";
        } catch {
          return false;
        }
      },
    },
  );
  if (!done.ok) return { ok: false, reply: done.reply };

  const j = done.job;
  if (!deduped) statusCache.prime(j.jobId, { jobId: j.jobId, status: j.status, message: j.message, ...(j.waiting ? { waiting: j.waiting } : {}) });
  else {
    deps.logger.info("duplicate submission answered with the existing job", { deviceId: device.deviceId, webJobId: j.jobId });
    track(deps, deps.web.postEvent({ deviceId: device.deviceId, type: "info", userAgent: ctx.userAgent, detail: { reason: "duplicate_submission", jobId: j.jobId } }));
  }

  // A repeat Print-Job gets the entry (and IPP job-id) the first one got; a repeat Send-Document fills in its own
  // Create-Job entry so the id the phone holds resolves to the same web job.
  if (deduped && !p.pending) {
    const existing = deps.registry.findByWebJobId(device.deviceId, j.jobId);
    if (existing) return { ok: true, entry: existing };
  }
  const latest = deduped ? (statusCache.peek(j.jobId) ?? j) : j;
  const name = p.jobName ?? "untitled";
  const entry = deps.registry.markSubmitted(
    device.deviceId,
    p.pending,
    {
      ippId: deps.registry.allocateId(),
      webJobId: j.jobId,
      state: (latest?.status ?? j.status) as JobState,
      message: latest?.message ?? j.message,
      waiting: latest?.waiting,
      bytes: done.bytes,
    },
    { name, userName: p.userName, attributes },
  );
  return { ok: true, entry };
}

/** Event + upload to the intake bucket + finalize. Never throws for refusals; a web/storage outage becomes a temporary-error reply. */
async function uploadAndFinalize(
  deps: GatewayDeps,
  ctx: RequestContext,
  device: ResolvedDevice,
  p: { jobName: string | undefined; doc: Buffer; ippVersion: string; opAttrs: FlatObject },
  attributes: FlatObject,
): Promise<FinalizedJob> {
  const declared = asString(p.opAttrs["document-format"]);
  await deps.web.postEvent({
    deviceId: device.deviceId,
    type: "job_received",
    userAgent: ctx.userAgent,
    detail: { sizeBytes: p.doc.length, documentFormat: declared ?? null, jobName: p.jobName ?? null },
  });

  const storagePath = intakePath(device.deviceId);
  try {
    await deps.storage.upload(storagePath, p.doc);
  } catch (err) {
    deps.logger.error("intake upload failed; asking the client to retry", { deviceId: device.deviceId, error: String(err) });
    return { ok: false, reply: { status: STATUS.temporaryError, message: "Storage is temporarily unavailable. Try again shortly." } };
  }

  let result;
  try {
    result = await deps.web.finalize({
      deviceId: device.deviceId,
      storagePath,
      fileName: sanitizeFileName(p.jobName),
      sizeBytes: p.doc.length,
      ipp: { jobName: p.jobName, userAgent: ctx.userAgent, ippVersion: p.ippVersion, attributes },
    });
  } catch (err) {
    // The PDF is already safe in the intake bucket; the client is told to retry rather than assume success.
    deps.logger.error("finalize failed after upload; intake object left in place", {
      deviceId: device.deviceId,
      storagePath,
      error: String(err),
    });
    return { ok: false, reply: { status: STATUS.temporaryError, message: "Printio is temporarily unavailable. Try again shortly." } };
  }
  if (result.kind === "bad_pdf") {
    await deps.web.postEvent({
      deviceId: device.deviceId,
      type: "job_rejected",
      userAgent: ctx.userAgent,
      detail: { reason: "bad_pdf", message: result.message },
    });
    return { ok: false, reply: { status: STATUS.documentFormatError, message: result.message } };
  }

  if (result.kind === "refused") {
    await deps.web.postEvent({
      deviceId: device.deviceId,
      type: "job_rejected",
      userAgent: ctx.userAgent,
      detail: { reason: result.reason, message: result.message ?? null },
    });
    const notAuthorized = result.reason === "revoked" || result.reason === "inactive_member";
    return {
      ok: false,
      reply: {
        status: notAuthorized ? STATUS.notAuthorized : STATUS.notPossible,
        message: result.message ?? REFUSAL_MESSAGES[result.reason],
      },
    };
  }

  return { ok: true, job: result.job, bytes: p.doc.length };
}

const REFUSAL_MESSAGES = {
  quota_exceeded: "You have used your print quota. Ask your administrator.",
  rate_limited: "Too many print jobs in a short time. Wait a few minutes and try again.",
  invalid_request: "Printio could not accept this job. Try printing again.",
  intake_not_found: "The document did not arrive at Printio. Try printing again.",
  revoked: "This device was removed in Printio. Add it again from Printio.",
  inactive_member: "This device's owner is no longer active.",
} as const;

// ---------- dispatch ----------

/**
 * Handles one decoded-or-raw IPP request body for the device behind `ctx.token`.
 * Returns null when the answer must be an HTTP 404 (a host that is not a known device: no information leak).
 * Never throws: failures become IPP error replies.
 */
export async function handleIppRequest(deps: GatewayDeps, ctx: RequestContext, body: Buffer): Promise<Buffer | null> {
  let msg: IppMessage;
  try {
    msg = decodeIpp(body);
  } catch (err) {
    deps.logger.warn("malformed IPP request", { error: err instanceof IppParseError ? err.message : String(err) });
    return errorReply(STATUS.badRequest, "Malformed IPP request.", body.subarray(0, 8));
  }
  try {
    return await dispatch(deps, ctx, msg);
  } catch (err) {
    if (err instanceof WebUnavailableError) {
      deps.logger.warn("web API unavailable", { op: OP_NAMES[msg.code], error: err.message });
      return buildReply(msg, { status: STATUS.temporaryError, message: "Printio is temporarily unavailable. Try again shortly." });
    }
    deps.logger.error("unhandled error in IPP handler", { op: OP_NAMES[msg.code], error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    return buildReply(msg, { status: STATUS.internalError, message: "Internal error." });
  }
}

async function dispatch(deps: GatewayDeps, ctx: RequestContext, msg: IppMessage): Promise<Buffer | null> {
  const opAttrs = flatten(msg.groups.find((g) => g.tag === TAG.operation));
  const jobTemplate = flatten(msg.groups.find((g) => g.tag === TAG.job));
  const isGetPrinterAttrs = msg.code === OP.getPrinterAttributes;
  const supported = (Object.values(OP) as number[]).includes(msg.code);

  // Identity is the Host header only.
  const resolved = await deps.web.resolveDevice(hashDeviceToken(ctx.token));
  if (resolved.kind !== "ok") {
    // Unknown device: Get-Printer-Attributes gets a bare 404 (nothing to learn); jobs get not-authorized.
    if (isGetPrinterAttrs && resolved.kind === "unknown") return null;
    const why =
      resolved.kind === "inactive_member"
        ? "This device's owner is no longer active."
        : resolved.kind === "revoked"
          ? "This device was removed in Printio. Add it again from Printio."
          : "This device is not registered with Printio.";
    return buildReply(msg, { status: STATUS.notAuthorized, message: why });
  }
  const device = resolved.device;
  if (!supported) return buildReply(msg, { status: STATUS.operationNotSupported, message: "Operation not supported." });

  const userName = asString(opAttrs["requesting-user-name"]) ?? "unknown";
  const jobName = asString(opAttrs["job-name"]);

  switch (msg.code) {
    case OP.getPrinterAttributes: {
      const throttleMap = attrEventSeen.get(deps) ?? new Map<string, number>();
      attrEventSeen.set(deps, throttleMap);
      const t = (deps.now ?? Date.now)();
      const seen = throttleMap.get(device.deviceId);
      if (seen === undefined || t - seen >= ATTR_EVENT_THROTTLE_MS) {
        throttleMap.set(device.deviceId, t);
        track(deps, deps.web.postEvent({ deviceId: device.deviceId, type: "attributes_requested", userAgent: ctx.userAgent }));
      }
      const attrs = buildPrinterAttributes({
        baseUrl: ctx.baseUrl,
        printerName: deps.printerName,
        uuidSeed: ctx.token,
        startedAt: deps.startedAt,
      });
      return buildReply(msg, {
        status: STATUS.ok,
        groups: [{ tag: TAG.printer, attrs: requestedFilter(attrs, opAttrs["requested-attributes"]) }],
      });
    }

    case OP.validateJob: {
      const declared = asString(opAttrs["document-format"]);
      if (!documentFormatAcceptable(declared, null)) {
        return buildReply(msg, { status: STATUS.documentFormatNotSupported, message: "Only PDF documents are supported." });
      }
      return buildReply(msg, { status: STATUS.ok });
    }

    case OP.printJob: {
      const r = await submitDocument(deps, ctx, device, {
        opAttrs,
        attributes: jobTemplate,
        jobName,
        userName,
        doc: msg.doc,
        ippVersion: msg.version,
        pending: null,
      });
      if (!r.ok) return buildReply(msg, r.reply);
      return buildReply(msg, submittedReply(deps, ctx, r.entry));
    }

    case OP.createJob: {
      const entry = deps.registry.createPending(device.deviceId, {
        name: jobName ?? "untitled",
        userName,
        attributes: jobTemplate,
      });
      return buildReply(msg, { status: STATUS.ok, groups: [{ tag: TAG.job, attrs: jobAttributes(deps, ctx, entry) }] });
    }

    case OP.sendDocument: {
      const id = ippJobId(opAttrs);
      const pending = id === null ? undefined : deps.registry.get(device.deviceId, id);
      if (!pending) return buildReply(msg, { status: STATUS.notFound, message: "No such job. It may have expired; print again." });
      if (pending.webJobId) {
        return buildReply(msg, { status: STATUS.notPossible, message: "This job already has its document." });
      }
      const r = await submitDocument(deps, ctx, device, {
        opAttrs,
        attributes: { ...pending.attributes, ...jobTemplate },
        jobName: pending.name === "untitled" ? undefined : pending.name,
        userName: pending.userName,
        doc: msg.doc,
        ippVersion: msg.version,
        pending,
      });
      if (!r.ok) return buildReply(msg, r.reply);
      return buildReply(msg, submittedReply(deps, ctx, r.entry));
    }

    case OP.getJobAttributes: {
      const id = ippJobId(opAttrs);
      const e = id === null ? undefined : deps.registry.get(device.deviceId, id);
      if (!e) return buildReply(msg, { status: STATUS.notFound, message: "No such job." });
      await refreshState(deps, device, e);
      return buildReply(msg, {
        status: STATUS.ok,
        groups: [{ tag: TAG.job, attrs: requestedFilter(jobAttributes(deps, ctx, e), opAttrs["requested-attributes"]) }],
      });
    }

    case OP.getJobs: {
      const completed = asString(opAttrs["which-jobs"]) === "completed";
      const limitRaw = first(opAttrs["limit"] as number | number[] | undefined);
      const limit = typeof limitRaw === "number" && limitRaw > 0 ? Math.min(limitRaw, MAX_IPP_ATTR_GROUPS_JOBS) : MAX_IPP_ATTR_GROUPS_JOBS;
      const entries = deps.registry.list(device.deviceId).sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_IPP_ATTR_GROUPS_JOBS);
      await Promise.all(
        entries.map((e) =>
          refreshState(deps, device, e).catch((err) =>
            deps.logger.warn("could not refresh job state; using last known", { error: String(err) }),
          ),
        ),
      );
      const groups: IppGroup[] = [];
      for (const e of entries) {
        const s = e.state ? mapJobState(e.state).state : IPP_JOB_STATE.pendingHeld;
        const isDone = s >= IPP_JOB_STATE.canceled;
        if (isDone !== completed) continue;
        if (groups.length >= limit) break;
        groups.push({
          tag: TAG.job,
          attrs: requestedFilter(jobAttributes(deps, ctx, e), opAttrs["requested-attributes"]),
        });
      }
      return buildReply(msg, { status: STATUS.ok, groups });
    }

    case OP.cancelJob: {
      const id = ippJobId(opAttrs);
      const e = id === null ? undefined : deps.registry.get(device.deviceId, id);
      if (!e) return buildReply(msg, { status: STATUS.notFound, message: "No such job." });
      if (!e.webJobId) {
        deps.registry.remove(device.deviceId, e.ippId);
        return buildReply(msg, { status: STATUS.ok });
      }
      const r = await deps.web.cancelJob(e.webJobId, device.deviceId);
      if (r.kind === "not_found") return buildReply(msg, { status: STATUS.notFound, message: "No such job." });
      if (r.kind === "not_cancellable") {
        return buildReply(msg, { status: STATUS.notPossible, message: r.message ?? "This job can no longer be cancelled." });
      }
      e.state = r.status;
      e.waiting = undefined;
      // The next poll must see the cancel, and a cancelled job must not be handed back for a repeat of the document.
      const rt = runtime(deps);
      rt.status.invalidate(e.webJobId);
      const cancelledWebJobId = e.webJobId;
      rt.dedupe.invalidate((v) => v.ok && v.job.jobId === cancelledWebJobId);
      return buildReply(msg, { status: STATUS.ok });
    }

    default:
      return buildReply(msg, { status: STATUS.operationNotSupported, message: "Operation not supported." });
  }
}
