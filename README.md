# Printio

Printio is a multi-tenant print management platform: a cloud web app (approval
workflows, quotas, audit trail) paired with an on-premises Windows Print Agent that
does the actual printing. It exists so that a document upload can be policy-checked,
queued, approved if needed, and routed to the correct physical printer queue — with
every step recorded — instead of relying on a shared network printer and hope. It is
built for organizations (schools, print shops, offices) that need to control *who*
can print *what* (color, page count, copies, paper size, finishing) without
babysitting a print queue by hand.

## Current status

This repository is currently a **single-organization prototype build-out** — the
author's own organization and a single physical printer (a Kyocera TASKalfa
MZ2501ci) — not yet a live multi-tenant SaaS deployment. It is deliberately built on
top of the **full multi-tenant architecture** described in
[docs/architecture.md](./docs/architecture.md) (organizations, membership roles,
per-org RLS, per-org policies and quotas) rather than a single-tenant shortcut, so
that it can grow into serving multiple organizations later without a rearchitecture.
Concretely: every table and Row Level Security policy is org-scoped from day one,
even though only one `organizations` row exists in this build.

See [docs/architecture.md](./docs/architecture.md) for the full design and its
research basis, and [docs/known-limitations.md](./docs/known-limitations.md) for
what this system does and does not guarantee (most importantly: "submitted to
spooler" is not the same as "physically printed," and finishing options like staple/
booklet/punch cannot be controlled from software — see architecture.md sec 9).

## Repo layout

```
/apps/web        Next.js cloud app (App Router) — deployed to Vercel.
/apps/agent      Windows Print Agent — Node.js/TypeScript, runs on-prem as a
                 console app or Windows service.
/packages/shared Types, the policy/rules engine, job state machine, and
                 page/sheet/cost math — imported by both apps/web and apps/agent.
/supabase        SQL migrations (source of truth) + a consolidated schema.sql
                 reference dump.
/docs            This documentation set.
```

## Documentation index

- [docs/architecture.md](./docs/architecture.md) — full system design, with the
  research basis for every non-obvious decision.
- [docs/known-limitations.md](./docs/known-limitations.md) — what Printio does not
  guarantee, and why.
- [docs/agent-api.md](./docs/agent-api.md) — the canonical Agent ↔ Cloud API
  contract.
- [docs/deployment.md](./docs/deployment.md) — Supabase project setup, manual
  dashboard steps, environment variables, and deploying `apps/web` to Vercel.
- [docs/agent-install.md](./docs/agent-install.md) — installing and operating the
  Windows Print Agent.
- [docs/printer-setup.md](./docs/printer-setup.md) — configuring the Kyocera KX
  driver, Windows printer queues, and finishing profiles; registering them as
  `printer_profiles` rows.
- [docs/testing.md](./docs/testing.md) — running the automated test suite, and the
  mandatory physical validation checklist before trusting a real print job.

## Prerequisites

- Node.js 20+ and [pnpm](https://pnpm.io/) (`packageManager: pnpm@10.33.0` is pinned
  in `package.json`).
- A [Supabase](https://supabase.com/) project (Postgres + Auth + Storage +
  Realtime).
- A host for `apps/web` — [Vercel](https://vercel.com/) is what
  [docs/deployment.md](./docs/deployment.md) documents, but any Node 20+ host that
  can run a Next.js app works.
- A Windows 10/11 or Windows Server machine to run `apps/agent`, network-reachable
  from at least one configured printer.
- At least one printer with a Windows printer queue already configured per
  [docs/printer-setup.md](./docs/printer-setup.md) (the driver/finishing setup is a
  one-time, on-site task independent of Printio's software).

## Quickstart (dev loop)

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local   # fill in your Supabase project's values
pnpm --filter @printio/web dev                 # cloud app
pnpm --filter @printio/agent dev                # windows agent (console mode; see apps/agent/README.md)
pnpm -r test                                    # every workspace package's unit tests
```

`apps/web` and `apps/agent` are pnpm workspace packages (`@printio/web`,
`@printio/agent`) alongside `@printio/shared`; see `pnpm-workspace.yaml` and the
root `package.json` scripts (`dev:web`, `dev:agent`, `build`, `test`, `lint`,
`typecheck`) for the other entry points. All three packages have real, tested code
today (see [docs/testing.md](./docs/testing.md)) — `pnpm -r build`, `pnpm -r test`,
and `pnpm -r typecheck` all pass clean as of this writing, and `.github/workflows/ci.yml`
runs the same four checks on every push/PR.

## Current status & next phase

Honest accounting, phase by phase (this build is **Phase 1–3 of the plan below**,
not Phase 4–6):

| Phase | Scope | Status |
|---|---|---|
| **1** | Core cloud: auth, organizations, PDF upload/preflight, jobs, basic dashboard | Implemented |
| **2** | Approval engine: policies, rules, approval queue, realtime, audit events | Implemented |
| **3** | Windows Agent: registration, heartbeat, printer discovery, download, printing, spooler monitoring, reconciliation | Implemented, **physically untested** — no Windows machine exists in this build environment; see [docs/testing.md](./docs/testing.md) for the mandatory validation procedure before trusting it on a real job |
| **4** | Printer management: multiple printers, profiles, advanced options, Windows queue mappings | Basic version implemented (`printer_profiles`, `windows_queue_name` mapping); room to grow (bulk queue management, richer capability UI) |
| **5** | Quotas/reporting: usage, quotas, reports, cost estimation | Quotas implemented (race-safe reservation, see architecture.md sec 14) with a full admin UI (organization/role/department/group/user scopes, `/admin/quotas`), including groups management (`/admin/groups`); Reports V1 shipped (`/admin/reports` — pages-by-month, color usage, by-user/department/printer breakdowns, recently denied/failed — tables, plus client-side CSV export) |
| **6** | Advanced features: booklet imposition, previews, SNMP telemetry, Google Drive, additional integrations | Real booklet **imposition** implemented, not just padding: each page is independently scaled (never upscaled) into its saddle-stitch slot, closer to how Adobe lays out booklets than driver defaults (`apps/web/lib/pdf/imposition.ts`, architecture.md sec 8); a client-side PDF thumbnail preview (page 1, rendered in-browser via pdfjs-dist, no upload needed) ships in the print form; SNMP telemetry, Drive/365 submission, and a packaged Windows installer are architecturally reserved (schema columns, doc sections) but not built — see [docs/known-limitations.md](./docs/known-limitations.md) "V1 scope" |

Beyond the original 6-phase plan:

- **First-login onboarding tour** (role-aware — students/staff vs admins get different
  content) and a **persistent Help menu** with a plain-language glossary.
- **Domain-restricted sign-in + 30-day forced re-authentication**: an org_admin sets
  `allowed_domains`; a brand-new user's first sign-in is gated against it (existing
  members are never gated by domain), and every user is required to re-authenticate
  (not just refresh a token) every 30 days (architecture.md sec 19).
- **Magic-link (email OTP) sign-in as a second, independent method** alongside Google
  OAuth, with its own per-organization toggle (`/admin/settings`) over whether the
  domain restriction applies to magic-link sign-ins specifically — Google OAuth's gate
  is never affected by this toggle (architecture.md sec 19.3).
  **Manual step still needed from you**: enabling the Email provider in the Supabase
  dashboard — see [docs/deployment.md](./docs/deployment.md) §2.4.
- **Cron sweep route batched/paginated** (`/api/cron/sweep`) so a large backlog of
  expiring approvals/leases/stuck jobs/retention purges spreads across multiple ticks
  instead of one long-running (or timing-out) invocation.
- **Agent resilience**: the outer poll loop now backs off (with a startup jitter) during
  a sustained cloud outage instead of hammering the API every 15 seconds forever, and a
  double-click Windows setup script (`apps/agent/scripts/setup-agent.bat`) handles
  install/registration/service-setup for someone who'd rather not type CLI commands.
- Route-level loading states across the main pages and a generated app icon.

All of the above shipped aimed squarely at making the day-to-day experience feel
considered rather than just functional, and at closing real gaps (auth resilience, cron
scalability, agent resilience, non-technical install) rather than only adding surface
features.

As of this writing, `apps/web` (Next.js cloud app: auth/bootstrap, upload+preflight,
policy+quota-checked submission, realtime approval queue, admin dashboard, the full
Agent-facing API in `docs/agent-api.md`, and the batched Vercel Cron retention/lease-expiry
sweep) and `apps/agent` (the full Windows Print Agent — registration, heartbeat,
job download, `SumatraPDF` execution, PowerShell spooler monitoring, the fixed
remote-command handler, local job queue with restart recovery, outage backoff) are both
real, building, typechecking, and passing their own unit test suites (`pnpm -r build`,
`pnpm -r typecheck`, `pnpm -r test` all green — 69 tests in `apps/web` alone as of this
writing). The live Supabase project this was built against (schema + RLS policies +
migrations through `0015_retention_files_purged_at.sql`) is likewise migrated and
verified via the Supabase advisor (no outstanding security lint findings of this
project's own making). Treat "implemented" as exactly that — real, tested code — but
**not** as "verified end-to-end against a real Windows Agent and printer": no Windows
machine or physical printer exists in this build environment, so
[docs/testing.md](./docs/testing.md)'s physical validation procedure has not yet
been run. Do not trust a real print job to this system until it has.

### What's left before this can go live for real users

Almost everything that's left at this point is **manual setup, not missing code** — see
[docs/deployment.md](./docs/deployment.md) end to end for the full sequence, but in short:
create/confirm the Supabase project, enable Google as an OAuth provider (§2.1) and Email
for magic-link (§2.4), set the environment variables in Vercel (§3), deploy `apps/web`
(§4), confirm Vercel Cron is hitting `/api/cron/sweep` (§5), and — separately, on the
actual Windows machine next to the printer — walk `docs/agent-install.md`'s "fast path"
to register and run the Agent, then manually add one `printer_profiles` row per
finishing-configured Windows queue from `/admin/printers` (guidance on exactly what each
field means and where to find it is inline in that form). None of that can be done from
inside this repository — it needs real API keys/dashboard access, which is the point at
which you come back in.

## License

Proprietary — an internal/private project, not currently licensed for external use
or redistribution.
