# @printio/gateway

IPP gateway for native printing (Windows 11 + Android for the MVP). A member adds a printer whose address is
`https://u-<token>.<BASE_DOMAIN>/ipp/print`; the OS print dialog sends a PDF; the gateway stores it in the
`print-jobs` bucket (`gateway-intake/<deviceId>/<uuid>.pdf`) and asks the web app to run it through the normal
pipeline (`/api/gateway/jobs/finalize`). Identity is the `Host` header only; the URL path is ignored.

Interface with the web app: `docs/superpowers/specs/2026-10-22-gateway-contract.md`. Protocol notes and what each
OS sends: `docs/ipp-printing.md`. The throwaway server this was ported from: `tools/ipp-spike/`.

## Status: what is and is not verified

- Verified by automated tests (`pnpm --filter @printio/gateway test`): IPP codec, advertised printer attributes,
  every operation against a fake web API and fake storage, using request shapes recorded from Windows 11 and
  Android in the spike; error codes, size limit, malformed input, web-down behaviour.
- **Not verified**: any real device, the real web API, real Supabase Storage, Cloudflare Tunnel with the wildcard
  hostname, and the Windows Service install. Do not claim any of that works until it has been tried.

## Run it (any OS, for testing)

```
pnpm install
cp apps/gateway/.env.example apps/gateway/.env   # fill it in
pnpm --filter @printio/gateway start             # or: dev (auto-reload)
```

`GET http://localhost:8631/healthz` answers `ok`. Everything else needs a device hostname in `Host`. To poke it
locally without DNS, send the header yourself, e.g. `curl -H "Host: u-<token>.<BASE_DOMAIN>" --data-binary @req.ipp http://localhost:8631/ipp/print`.

Behaviour in short: unknown host or non-device hostname -> HTTP 404; unknown/revoked device -> IPP
`client-error-not-authorized`; web down / 5xx / storage failure -> `server-error-temporary-error` (clients retry);
non-PDF -> `client-error-document-format-not-supported` plus a `job_rejected` event; oversized body ->
`client-error-request-entity-too-large`; malformed IPP -> `client-error-bad-request`. Create-Job state is kept in
memory for 10 minutes; job-id -> web job mapping is in memory too, so after a gateway restart old job ids answer
`client-error-not-found` (printing itself is unaffected).

## Cloudflare Tunnel (wildcard hostname)

Cloudflare terminates TLS and forwards plain HTTP to the gateway. Do **not** override the host header: the
gateway needs the original `u-<token>.szvtech.org` in `Host`.

`~/.cloudflared/config.yml` (Windows: `C:\Users\<you>\.cloudflared\config.yml`):

```yaml
tunnel: <TUNNEL_ID>
credentials-file: C:\Users\<you>\.cloudflared\<TUNNEL_ID>.json
ingress:
  - hostname: "*.szvtech.org"
    service: http://localhost:8631
    # no originRequest.httpHostHeader here, on purpose
  - service: http_status:404
```

One wildcard DNS record in the Cloudflare dashboard (DNS > Records), proxied (orange cloud):

| Type | Name | Target |
|---|---|---|
| CNAME | `*` | `<TUNNEL_ID>.cfargotunnel.com` |

(or `cloudflared tunnel route dns <TUNNEL_NAME> "*.szvtech.org"`). Explicit records, such as the web app's own
subdomain, win over the wildcard. Install cloudflared as a service too (`cloudflared service install`) so the
tunnel also survives reboots. The tunnel token / credentials file is a secret: never commit it.

## Install as an auto-restarting Windows service

Same approach as `apps/agent` (node-windows + `service-launcher.mjs`, which registers tsx because `@printio/shared`
ships TypeScript source). Needs Node 20+ and pnpm on the Windows PC.

1. `pnpm install` (this pulls the optional `node-windows`; if it did not, `pnpm --filter @printio/gateway add node-windows`).
2. Create `apps/gateway/.env` from `.env.example`.
3. Test in the foreground first: `pnpm --filter @printio/gateway start`, then Ctrl+C.
4. In an **Administrator** PowerShell: `pnpm --filter @printio/gateway install-service`.
   This registers the service "Printio IPP Gateway", starts it, and sets the Service Control Manager to restart it
   after a crash (5 s, 15 s, then 60 s).
5. Check: `Get-Service "Printio IPP Gateway"` and `Invoke-WebRequest http://localhost:8631/healthz`.
6. Remove: `pnpm --filter @printio/gateway uninstall-service`.

The service runs as Local System by default and reads `apps/gateway/.env`; restrict that file's permissions to
Administrators. Logs are JSON lines on stdout (node-windows writes them under `daemon\` next to the launcher).
This install path has not been run on a real Windows machine yet.

## Layout

```
src/ipp/codec.ts               IPP encode/decode (collections included)
src/ipp/printer-attributes.ts  advertised printer description + requested-attributes filter
src/handlers.ts                operations, state mapping, events
src/job-registry.ts            per-device in-memory job state (10 min Create-Job TTL)
src/server.ts                  http server (Host -> token, any path, size limit, never crashes)
src/web-client.ts              /api/gateway/* client (Bearer, timeouts, 60 s resolve cache)
src/storage.ts                 Supabase Storage upload behind an interface
src/config.ts, logger.ts, index.ts, windows-service.ts
test/                          vitest (fake web API + fake storage over a real HTTP server)
```
