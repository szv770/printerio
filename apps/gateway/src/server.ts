// Node http server for the gateway. Identity is the Host header (u-<token>.<BASE_DOMAIN>); the URL path is ignored.
// Cloudflare terminates TLS and speaks plain HTTP to us (X-Forwarded-Proto says what the client used).
import http from "node:http";
import { tokenFromHost } from "@printio/shared/device-token";
import { errorReply, handleIppRequest, type GatewayDeps } from "./handlers.js";
import { STATUS } from "./ipp/codec.js";

export interface GatewayServerOptions {
  deps: GatewayDeps;
  baseDomain: string;
  maxBodyBytes: number;
  /** Stop reading (destroy the socket) once an oversized upload has sent this many times the limit. Default 4. */
  drainFactor?: number;
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

  const sendText = (res: http.ServerResponse, code: number, text: string): void => {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(code, { "content-type": "text/plain", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };
  const sendIpp = (res: http.ServerResponse, body: Buffer, close = false): void => {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(200, {
      "content-type": "application/ipp",
      "content-length": body.length,
      ...(close ? { connection: "close" } : {}),
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
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (tooLarge) {
          if (size > drainLimit) req.destroy();
          return;
        }
        chunks.push(c);
        if (size > maxBodyBytes) {
          tooLarge = true;
          head = Buffer.concat(chunks).subarray(0, 8);
          chunks.length = 0; // free the memory; keep draining the rest so the client can read our answer
        }
      });
      req.on("error", (err) => log.warn("request stream error", { error: String(err) }));
      req.on("end", () => {
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
