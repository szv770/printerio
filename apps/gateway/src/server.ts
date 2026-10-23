// Node http server for the gateway. Identity is the Host header (u-<token>.<BASE_DOMAIN>); the URL path is ignored.
// Cloudflare terminates TLS and speaks plain HTTP to us (X-Forwarded-Proto says what the client used).
import http from "node:http";
import { tokenFromHost } from "@printio/shared/device-token";
import { errorReply, handleIppRequest, type GatewayDeps } from "./handlers.js";
import { STATUS } from "./ipp/codec.js";
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
}

function forwardedProto(req: http.IncomingMessage): "http" | "https" {
  const raw = req.headers["x-forwarded-proto"];
  const v = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim().toLowerCase();
  return v === "https" ? "https" : "http";
}

export function createGatewayServer(opts: GatewayServerOptions): http.Server {
  const { deps, baseDomain, maxBodyBytes } = opts;
  const drainLimit = maxBodyBytes * (opts.drainFactor ?? 4);
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

  const server = http.createServer((req, res) => {
    try {
      if (req.method === "GET" && req.url?.split("?")[0] === "/healthz") {
        req.resume();
        return sendText(res, 200, "ok");
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

      req.on("data", (c: Buffer) => {
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
      req.on("error", (err) => log.warn("request stream error", { error: String(err) }));
      req.on("end", () => {
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
            const out = await handleIppRequest(
              deps,
              {
                token,
                baseUrl: `${forwardedProto(req)}://${req.headers.host}`,
                userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
              },
              Buffer.concat(chunks),
            );
            if (out === null) {
              log.info("reply", { http: 404, note: "device not registered" });
              return sendText(res, 404, "not found");
            }
            // Bytes 2-3 of an IPP response are its status code (0 = ok).
            log.info("reply", { http: 200, ippStatus: out.length >= 4 ? out.readUInt16BE(2) : undefined });
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
  });

  server.on("clientError", (err, socket) => {
    log.debug("client error", { error: String(err) });
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  // Big PDFs over slow links: allow up to 10 minutes for a whole request.
  server.requestTimeout = 10 * 60 * 1000;
  return server;
}
