# PrintOS

PrintOS is a multi-tenant print management platform: a cloud web app (approval
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
- [docs/known-limitations.md](./docs/known-limitations.md) — what PrintOS does not
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
  one-time, on-site task independent of PrintOS's software).

## Quickstart (dev loop)

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local   # fill in your Supabase project's values
pnpm --filter @printos/web dev                 # cloud app
pnpm --filter @printos/agent dev                # windows agent (console mode; see apps/agent/README.md)
pnpm -r test                                    # every workspace package's unit tests
```

`apps/web` and `apps/agent` are pnpm workspace packages (`@printos/web`,
`@printos/agent`) alongside `@printos/shared`; see `pnpm-workspace.yaml` and the
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
| **5** | Quotas/reporting: usage, quotas, reports, cost estimation | Quotas implemented (race-safe reservation, see architecture.md sec 14) with a full admin UI (organization/role/department/group/user scopes, `/admin/quotas`), including groups management (`/admin/groups`); Reports V1 shipped (`/admin/reports` — pages-by-month, color usage, by-user/department/printer breakdowns, recently denied/failed — tables only, no charts/exports yet) |
| **6** | Advanced features: booklet padding, previews, SNMP telemetry, Google Drive, additional integrations | Booklet padding implemented (architecture.md sec 8); SNMP telemetry, Drive/365 submission, PDF previews, and a packaged Windows installer are architecturally reserved (schema columns, doc sections) but not built — see [docs/known-limitations.md](./docs/known-limitations.md) "V1 scope" |

As of this writing, `apps/web` (Next.js cloud app: auth/bootstrap, upload+preflight,
policy+quota-checked submission, realtime approval queue, admin dashboard, the full
Agent-facing API in `docs/agent-api.md`, and the Vercel Cron retention/lease-expiry
sweep) and `apps/agent` (the full Windows Print Agent — registration, heartbeat,
job download, `SumatraPDF` execution, PowerShell spooler monitoring, the fixed
remote-command handler, local job queue with restart recovery) are both real,
building, typechecking, and passing their own unit test suites (`pnpm -r build`,
`pnpm -r typecheck`, `pnpm -r test` all green). The live Supabase project this was
built against (schema + RLS policies) is likewise migrated and verified via the
Supabase advisor (no outstanding security lint findings of this project's own
making). Treat "implemented" as exactly that — real, tested code — but **not** as
"verified end-to-end against a real Windows Agent and printer": no Windows machine
or physical printer exists in this build environment, so
[docs/testing.md](./docs/testing.md)'s physical validation procedure has not yet
been run. Do not trust a real print job to this system until it has.

## License

Proprietary — an internal/private project, not currently licensed for external use
or redistribution.
