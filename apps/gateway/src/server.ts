// Node http server for the gateway. Identity is the Host header (u-<token>.<BASE_DOMAIN>); the URL path is ignored.
// Cloudflare terminates TLS and speaks plain HTTP to us (X-Forwarded-Proto says what the client used).
import http from "node:http";
import { hashDeviceToken, tokenFromHost } from "@printio/shared/device-token";
import { errorReply, handleIppRequest, type GatewayDeps } from "./handlers.js";
import { STATUS } from "./ipp/codec.js";
import { clientIpFor, DEFAULT_LIMITS, DEFAULT_TRUSTED_PROXIES, RateLimiter, type ServerLimits } from "./request-limits.js";
import { DEFAULT_MAX_INFLIGHT_BYTES, DEFAULT_MAX_UPLOADS_PER_DEVICE, UploadGuard, type UploadLease } from "./upload-guard.js";

export const BUSY_MESSAGE = "The server is busy right now. Please try again in a moment.";
/** Seconds a busy client is told to wait (HTTP Retry-After). */
export const BUSY_RETRY_AFTER_SECONDS = 10;
/** Requests with a body this small (status polls, Validate-Job, attributes) are never counted or refused by the busy guard. */
export const GUARD_THRESHOLD_BYTES = 64 * 1024;

export interface GatewayServerOptions {
  deps: GatewayDeps;
  baseDomain: string;
  maxBodyBytes: number;
  /** Stop reading (destroy the socket) once an oversized upload has sent this many times the limit. Default 4. */
  drainFactor?: number;
  /** Busy guard: caps on in-flight upload bytes and uploads per device. Default 150 MB and 2 (see upload-guard.ts). */
  guard?: UploadGuard;
  /** Abuse limits (see request-limits.ts). Any field may be overridden. */
  limits?: Partial<ServerLimits>;
  /** TCP peers allowed to vouch for CF-Connecting-IP (the local cloudflared). Default: loopback only. */
  trustedProxies?: readonly string[];
}

/** IPP operation id (bytes 2-3 of a request) as hex, e.g. "0x000b" = Get-Printer-Attributes; for the log only. */
function ippOpHex(body: Buffer): string | undefined {
  return body.length >= 4 ? `0x${body.readUInt16BE(2).toString(16).padStart(4, "0")}` : undefined;
}

function forwardedProto(req: http.IncomingMessage): "http" | "https" {
  const raw = req.headers["x-forwarded-proto"];
  const v = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim().toLowerCase();
  return v === "https" ? "https" : "http";
}

export function createGatewayServer(opts: GatewayServerOptions): http.Server {
  const { deps, baseDomain, maxBodyBytes } = opts;
  const limits: ServerLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const trusted = opts.trustedProxies ?? DEFAULT_TRUSTED_PROXIES;
  const perIp = new RateLimiter({ max: limits.perIpRequestsPerMin, windowMs: 60_000 });
  const global = new RateLimiter({ max: limits.globalRequestsPerMin, windowMs: 60_000, maxKeys: 1 });
  const unknownPerIp = new RateLimiter({ max: limits.unknownTokensPerIpPerMin, windowMs: 60_000 });
  const log = deps.logger;
  const guard =
    opts.guard ??
    new UploadGuard({
      // Never lower than one legal file, or a file at the per-file limit could never be admitted.
      maxInflightBytes: Math.max(DEFAULT_MAX_INFLIGHT_BYTES, maxBodyBytes),
      maxPerKey: DEFAULT_MAX_UPLOADS_PER_DEVICE,
    });

  const sendText = (res: http.ServerResponse, code: number, text: string): void => {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(code, { "content-type": "text/plain", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };
  const sendIpp = (res: http.ServerResponse, body: Buffer, close = false, extra: Record<string, string> = {}): void => {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(200, {
      "content-type": "application/ipp",
      "content-length": body.length,
      ...(close ? { connection: "close" } : {}),
      ...extra,
    });
    res.end(body);
  };

  /** Answer now and drop the connection without reading the rest of the body. */
  const refuse = (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer, extra: Record<string, string> = {}): void => {
    sendIpp(res, body, true, extra);
    res.once("finish", () => req.destroy());
  };
  const busyBody = (): Buffer => errorReply(STATUS.serverBusy, BUSY_MESSAGE);
  const busyHeaders = { "retry-after": String(BUSY_RETRY_AFTER_SECONDS) };

  const server = http.createServer({ maxHeaderSize: limits.maxHeaderBytes, connectionsCheckingInterval: Math.min(1000, Math.max(50, limits.headersTimeoutMs / 2)) }, (req, res) => {
    try {
      if (req.method === "GET" && req.url?.split("?")[0] === "/healthz") {
        req.resume();
        return sendText(res, 200, "ok");
      }
      const ip = clientIpFor(req.socket.remoteAddress, req.headers, trusted);
      // The sender's own limit is checked FIRST, and the shared allowance is charged only for a request that passed it.
      // The other way round, one address flooding junk used up the shared allowance and every real print was refused.
      if (!perIp.take(ip) || !global.take("g")) {
        log.warn("rate limited", { ip });
        if (req.method === "POST" && tokenFromHost(req.headers.host, baseDomain)) return refuse(req, res, busyBody(), busyHeaders);
        req.destroy();
        return;
      }
      const token = tokenFromHost(req.headers.host, baseDomain);
      const seen = {
        method: req.method,
        host: req.headers.host,
        path: req.url?.split("?")[0],
        userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
      };
      if (!token || req.method !== "POST") {
        // Not a device hostname (or not an IPP POST): say nothing to the caller, but leave a line for the operator.
        log.info("ignored request", { ...seen, reason: !token ? "not a device hostname" : "not an IPP POST" });
        req.resume();
        return sendText(res, 404, "not found");
      }

      log.info("request", seen);
      // Identity first, document second: the device is looked up (cached, incl. a short negative cache) BEFORE any of
      // the body is read, so invented tokens can neither hold upload budget nor make us buffer megabytes.
      req.pause();
      void (async () => {
        let limit = maxBodyBytes;
        let known = false;
        try {
          if (unknownPerIp.isLimited(ip)) {
            log.warn("rate limited: too many unknown device tokens", { ip });
            return refuse(req, res, busyBody(), busyHeaders);
          }
          const r = await deps.web.resolveDevice(hashDeviceToken(token));
          known = r.kind === "ok";
          if (r.kind !== "ok") {
            if (r.kind === "unknown") unknownPerIp.take(ip);
            limit = Math.min(maxBodyBytes, limits.unauthBodyBytes);
          }
        } catch {
          limit = Math.min(maxBodyBytes, limits.unauthBodyBytes);
          if (declaredLength(req) > limit) return refuse(req, res, errorReply(STATUS.temporaryError, "Printio is temporarily unavailable. Try again shortly."));
        }
        if (!known && declaredLength(req) > limit) {
          return refuse(req, res, errorReply(STATUS.notAuthorized, "This device is not registered with Printio."));
        }
        serve(req, res, token, limit);
      })().catch((err) => {
        log.error("unhandled error before reading body", { error: String(err) });
        refuse(req, res, errorReply(STATUS.internalError, "Internal error."));
      });
    } catch (err) {
      log.error("unhandled error in request listener", { error: String(err) });
      sendText(res, 500, "internal error");
    }
  });

  function declaredLength(req: http.IncomingMessage): number {
    const n = Number(req.headers["content-length"]);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function serve(req: http.IncomingMessage, res: http.ServerResponse, token: string, maxBodyBytes: number): void {
    const drainLimit = maxBodyBytes * (opts.drainFactor ?? 4);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      let head: Buffer | undefined;
      // First 8 bytes of the body (IPP version + request id), kept even when the rest is thrown away, so a refusal
      // can echo the client's request id.
      let first8: Buffer = Buffer.alloc(0);

      // ---- busy guard ----
      // An "upload" is any request whose body is bigger than GUARD_THRESHOLD_BYTES (known up front from
      // Content-Length, or noticed as a chunked body grows). It holds a lease on the in-flight byte total and on its
      // device's upload slots until the request is completely finished, however it finishes.
      const declaredRaw = Number(req.headers["content-length"]);
      const declared = Number.isFinite(declaredRaw) && declaredRaw >= 0 ? declaredRaw : undefined;
      let lease: UploadLease | null = null;
      let busy = false;
      let handlerStarted = false;
      const releaseLease = (): void => lease?.release();
      const markBusy = (why: string): void => {
        if (busy) return;
        busy = true;
        chunks.length = 0; // keep draining, keep nothing
        releaseLease();
        log.warn("busy: refused an upload", {
          reason: why,
          declaredBytes: declared,
          inflightBytes: guard.inflightBytes,
          activeUploads: guard.activeUploads,
          capBytes: guard.maxInflightBytes,
        });
      };
      const takeLease = (bytesSoFar: number): void => {
        lease = guard.tryAcquire(token);
        if (!lease) return markBusy("too many uploads from this device at once");
        if (!lease.reserve(bytesSoFar)) markBusy("too many uploads in progress");
      };
      // If the client goes away before the request body is complete the handler below never runs, so release here.
      // Once the handler has started it releases in its own finally (the document is still in memory until then).
      const onGone = (): void => {
        if (!handlerStarted) releaseLease();
      };
      req.once("close", onGone);
      res.once("close", onGone);
      if (declared !== undefined && declared <= maxBodyBytes && declared > GUARD_THRESHOLD_BYTES) takeLease(declared);

      let stall: NodeJS.Timeout | undefined;
      const armStall = (): void => {
        clearTimeout(stall);
        stall = setTimeout(() => {
          log.warn("request body stalled; closing", { receivedBytes: size });
          req.destroy();
        }, limits.bodyStallMs);
        stall.unref();
      };
      armStall();
      req.once("close", () => clearTimeout(stall));
      req.on("data", (c: Buffer) => {
        armStall();
        size += c.length;
        if (first8.length < 8) first8 = Buffer.concat([first8, c.subarray(0, 8 - first8.length)]);
        if (tooLarge || busy) {
          if (size > drainLimit) req.destroy();
          return;
        }
        chunks.push(c);
        if (size > maxBodyBytes) {
          tooLarge = true;
          head = Buffer.concat(chunks).subarray(0, 8);
          chunks.length = 0; // free the memory; keep draining the rest so the client can read our answer
          releaseLease();
          return;
        }
        // Chunked / unknown length: start counting once the body is clearly an upload, then count every byte.
        if (declared === undefined) {
          if (lease) {
            if (!lease.reserve(c.length)) markBusy("too many uploads in progress");
          } else if (size > GUARD_THRESHOLD_BYTES) {
            takeLease(size);
          }
        }
      });
      req.resume(); // it was paused while the device was being looked up
      req.on("error", (err) => log.warn("request stream error", { error: String(err) }));
      req.on("end", () => {
        clearTimeout(stall);
        handlerStarted = true;
        void (async () => {
          try {
            if (tooLarge) {
              log.warn("rejected oversized upload", { limit: maxBodyBytes });
              return sendIpp(
                res,
                errorReply(STATUS.requestEntityTooLarge, "The document is larger than the upload limit.", head),
                true,
              );
            }
            if (busy) {
              return sendIpp(res, errorReply(STATUS.serverBusy, BUSY_MESSAGE, first8), true, {
                "retry-after": String(BUSY_RETRY_AFTER_SECONDS),
              });
            }
            const requestBody = Buffer.concat(chunks);
            const out = await handleIppRequest(
              deps,
              {
                token,
                baseUrl: `${forwardedProto(req)}://${req.headers.host}`,
                userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
              },
              requestBody,
            );
            if (out === null) {
              log.info("reply", { http: 404, op: ippOpHex(requestBody), note: "device not registered" });
              return sendText(res, 404, "not found");
            }
            // Bytes 2-3 of an IPP response are its status code (0 = ok).
            log.info("reply", { http: 200, op: ippOpHex(requestBody), ippStatus: out.length >= 4 ? out.readUInt16BE(2) : undefined });
            sendIpp(res, out);
          } catch (err) {
            log.error("unhandled error serving request", { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
            sendIpp(res, errorReply(STATUS.internalError, "Internal error."));
          } finally {
            // ALWAYS: success, refusal, thrown error. Idempotent, so the close handlers cannot double-release.
            releaseLease();
          }
        })();
      });
    } catch (err) {
      log.error("unhandled error in request listener", { error: String(err) });
      sendText(res, 500, "internal error");
    }
  }

  server.on("clientError", (err, socket) => {
    log.debug("client error", { error: String(err) });
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  // Big PDFs over slow links: allow up to 10 minutes for a whole request.
  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = limits.headersTimeoutMs;
  server.keepAliveTimeout = 30_000;
  server.maxConnections = limits.maxConnections;
  return server;
}
