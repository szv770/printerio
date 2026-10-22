# Handoff: IPP gateway (print from the OS print dialog)

Written 2026-10-22 at the end of a cloud session, for whoever continues (the owner in a terminal CLI, or another Claude session).
Branch: `claude/wireless-printer-app-tz73ni` (default branch of the repo is `claude/upcoming-large-project-3d2j9p`; there is no `main`).
Read order: `CLAUDE.md` -> this file -> `docs/superpowers/specs/2026-10-22-gateway-contract.md` (the interface, with a "Web-side details" addendum)
-> `docs/superpowers/specs/2026-10-20-printio-setup-design.md` (phases and decisions) -> `docs/ipp-printing.md`, `docs/kyocera-raw-print.md`.

## Goal in one paragraph
Staff print from their own phones and laptops through the normal print dialog (like PaperCut / Mobility Print). Each member has a personal
hostname `https://u-<39-char token>.szvtech.org/ipp/print` (identity lives in the hostname because Android only accepts a bare host).
An IPP gateway (Node service, runs on the "MLM Office" Windows server behind a Cloudflare Tunnel) receives the PDF, uploads it to Supabase
Storage, and calls the web app's `/api/gateway/*` endpoints, which run the existing Printio pipeline (preflight, policy, quota, approval) and
create a `print_jobs` row with `source='ipp'`. The existing Agent then prints (design: direct raw port 9100 with PJL + PDF).
MVP devices: **Windows 11 and Android first**. iPhone/Mac later.

## State of the code (all on the branch above, merged, CI-equivalent run clean)
Verified locally on the merged tree: `pnpm -r typecheck`, `lint`, `test`, `build` all pass (shared 62, web 572, gateway 44, agent 137 tests).
**Nothing has run against a real device, the real Supabase, Vercel, Cloudflare, or the printer.**

| Piece | Where | Status |
|---|---|---|
| Token helpers | `packages/shared/src/device-token.ts` (subpath `@printio/shared/device-token`) | done, tested |
| Contract | `docs/superpowers/specs/2026-10-22-gateway-contract.md` | done; addendum added by the web side |
| Gateway service | `apps/gateway/` (README + `.env.example` inside) | done, unit/e2e tested with fakes; **never run on Windows or against real devices** |
| DB migration | `supabase/migrations/0032_member_devices.sql` (+ `schema.sql`, `database.types.ts`) | written, **NOT applied anywhere** |
| Job pipeline core | `apps/web/lib/jobs/create-print-job.ts` (redirect-free; `forcedHeldReason`); `print/actions.ts` now a thin wrapper | done, characterization tests with a mocked client |
| IPP -> PrintChoices | `apps/web/lib/gateway/ipp-choices.ts` | done, 67 table tests |
| Gateway routes | `apps/web/app/api/gateway/{device/resolve,events,jobs/finalize,jobs/[jobId],jobs/[jobId]/cancel}` | done, mocked tests |
| Device helpers | `apps/web/lib/devices/devices.ts` | done (create/revoke/list/record events); **no UI yet** |
| Raw-port printing from the Agent | design only (`docs/kyocera-raw-print.md`); `apps/agent` has `raw-print-executor` | check what is wired before relying on it |
| Spike server (Pi) | `tools/ipp-spike/` | still the reference; stable 24 h |

## Known gaps / follow-ups (priority order)
1. **Gateway does not map web `finalize` refusals**: any status except 200/422 becomes IPP 0x0506 (client retries). The web can answer
   `403 quota_exceeded`, `429 rate_limited`, `400 invalid_request`, `404 intake_not_found`, `503 no_printer`, `500 internal_error`
   (see the contract addendum). Map permanent ones to a client-error IPP status with a readable message; keep 503/500/network as 0x0506.
   File: `apps/gateway/src/web-client.ts` (`finalize`), plus handler + test.
2. Orphan intake objects under `gateway-intake/` in the `print-jobs` bucket when finalize fails with 5xx (kept on purpose for retry). Add a cleanup.
3. Gateway job ids are in memory: after a gateway restart old job ids answer not-found (printing unaffected). Fine for MVP.
4. `device/resolve` is cached 60 s in the gateway, so a revoked device can still print up to a minute.
5. Body > 4x the size limit gets the socket cut instead of a clean IPP error.
6. `first_printed_at` is never set (needs the Agent status route). `group_members` policy lookup is user-filtered only (multi-org member edge case).
7. Create-Job reply uses state 4 (pending-held) with reason `job-incoming`; standard but unproven on Windows.
8. Review the SQL by eye before applying: RLS policies, the `(user_id, organization_id)` FK to `organization_members`, revoke/grant order,
   column-level SELECT that hides `token_hash`. The embedded select (`printers!inner`, `agents!inner`) is type-checked only.
9. Not built yet: "My devices" page (create device, show address + QR once, revoke), Admin > Devices, "I'm having trouble" form,
   stamp on printed pages (Phase 3), finishings from the dialog (Phase 4), cleanup (Phase 6).

## What the owner must do (in order) - nothing below has been done
1. Review and merge the PR for this branch into `claude/upcoming-large-project-3d2j9p` (CI should be green; Vercel bot comments are noise).
2. **Apply migration 0032** to Supabase (Supabase MCP `apply_migration`, or the SQL editor). It is idempotent-style but untested.
3. Vercel env vars (Production): `GATEWAY_SHARED_SECRET` (32+ random chars; generate with `openssl rand -hex 32`), `GATEWAY_BASE_DOMAIN=szvtech.org`. Redeploy.
4. Make sure the org has an **active raw-mode printer profile** (otherwise `finalize` answers 503 `no_printer`).
5. Cloudflare (domain szvtech.org): a **named tunnel** with public hostname `*.szvtech.org` -> `http://localhost:8631`, no host-header override,
   plus one wildcard DNS CNAME `*` -> `<tunnel-id>.cfargotunnel.com` (proxied). Exact config is in `apps/gateway/README.md`.
   The Pi's existing `cloudflared` service is a different tunnel; leave it alone. Quick tunnels need `--config /dev/null`.
6. Gateway host ("MLM Office" Windows server, Tailscale + RDP): `apps/gateway/README.md` has the `.env` (`WEB_BASE_URL`, `GATEWAY_SHARED_SECRET`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BASE_DOMAIN`, `PORT`=8631, `PRINTER_NAME`) and the auto-restart Windows service install
   (mirrors `apps/agent`; **never run on Windows yet**, expect to debug it).
7. Create a device row to get an address: until the My devices page exists, call `createDevice` from `apps/web/lib/devices/devices.ts`
   (e.g. a one-off script or SQL + token helper) - it returns the raw token once. Hostname = `u-<token>.szvtech.org`.
8. Real-device tests, labelled prints (say what you saw; nothing counts as working before this):
   - Windows 11: Settings > Printers > Add > "The printer that I want isn't listed" > "Select a shared printer by name" > `https://u-<token>.szvtech.org/ipp/print`.
   - Pixel 8: Settings > Connected devices > Connection preferences > Printing > Default Print Service > menu > Add printer > Add by IP/hostname
     (bare `u-<token>.szvtech.org`, no path).
   - Then check the job appears in Printio (source = ipp) and prints.
9. **Magic-link email template (required for phone sign-in).** Tapping the email link in the Gmail app opens an in-app browser with a different
   cookie jar, so the default PKCE link (`{{ .ConfirmationURL }}`) loops back to the login page. The callback now also accepts a server-verified
   `token_hash` link. In Supabase: Authentication > Emails > Templates > Magic Link, set the link href to exactly:
   `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email`
   and do NOT use `{{ .ConfirmationURL }}` anywhere in the template. Also set Authentication > URL Configuration > **Site URL** to
   `https://printio.szvtech.org` (the template builds the link from it). Google OAuth is unaffected. A bad/expired link lands on
   `/login?reason=link_invalid` with a "request a new one" message.

## Facts already proven (do not re-derive)
- Windows 11 sends PDF via Create-Job + Send-Document; Android via Validate-Job + Print-Job; ChromeOS/CUPS sends PDF (client probably the Chromebook, unconfirmed).
- Kyocera TASKalfa MZ8500i (192.168.100.168) accepts PJL header + PDF direct (`@PJL ENTER LANGUAGE=PDF`) on port 9100: duplex long edge,
  staples (each switch rotates the staple 90 degrees), booklets both bindings via app-side imposition. Mono, landscape, paper size/tray, punch: unverified.
- Android only accepts a bare hostname (so identity is in the hostname); Windows' scripted one-click setup failed (manual wizard works).
- Cloudflare Universal SSL covers `*.szvtech.org` one level deep only, hence `u-<token>.szvtech.org`.

## Still open from before this build
- **iPhone**: the AirPrint `.mobileconfig` installs ("one AirPrint device added") but the printer does not show in Share > Print. Undiagnosed.
  Hypotheses: stale tunnel address in the profile; printer description not AirPrint-compliant (needs `image/urf` + `urf-supported`).
  Need: the address inside the profile vs the live one, and the Pi's `tail spike-data/requests.jsonl` / `curl /report/<token>`.
- Apple (Mac `lpadmin`, iPhone) untested; Chromebook client unconfirmed; Pi quick tunnel dies when the SSH session closes (use the named tunnel/`systemd`).

## Working agreements (owner)
Ask clarifying questions on detailed behavior, give a recommendation not a survey; split independent work across agents (two at a time);
keep usage low; give exact copy-paste steps and say plainly what is untested. Never commit secrets or tunnel tokens.
