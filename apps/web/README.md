# @printos/web

The PrintOS cloud app: Next.js 16 (App Router), Supabase (Auth/Postgres/Storage/Realtime).

See the root [README.md](../../README.md) and [docs/](../../docs) for the full picture -
architecture, deployment, auth/bootstrap model, agent API contract. This file only covers
running this app locally.

## Setup

```bash
pnpm install
cp .env.example .env.local   # fill in your Supabase project's values
pnpm --filter @printos/web dev
```

Required env vars are documented in `.env.example`. At minimum you need a Supabase project
with the migrations in `supabase/migrations/` applied (see `docs/deployment.md`), Google
OAuth enabled as an Auth provider in that project, and `PRINTOS_BOOTSTRAP_ADMIN_EMAIL` set to
your own email so your first sign-in becomes `org_admin` of a newly created organization
(see `lib/auth/bootstrap.ts` and `docs/architecture.md` sec 2.2).

## Structure

- `app/` - routes. `app/print`, `app/jobs` are the student/staff-facing upload+track flow;
  `app/admin/**` is the admin dashboard; `app/api/agents/**` is the Agent-facing API
  (contract: `docs/agent-api.md`); `app/api/cron/sweep` is the retention/lease-expiry sweep
  Vercel Cron hits (see `vercel.json`).
- `lib/supabase/` - `client.ts` (browser), `server.ts` (Server Components/Actions, RLS-governed),
  `service-role.ts` (bypasses RLS - only for the handful of operations documented inline).
- `lib/pdf/` - server-side PDF preflight (`preflight.ts`) and booklet padding (`booklet.ts`),
  both via `pdf-lib`.
- `lib/policy/build-facts.ts` - assembles `JobFacts` from live DB state and calls
  `@printos/shared`'s pure policy engine.
- `lib/quota.ts` - quota lookup + the atomic reserve/release/consume RPC wrapper.
- `lib/agent-auth.ts` - Agent bearer-credential verification (device secret hashing/compare).

## Known V1 simplifications (see docs/known-limitations.md for the full list)

- The print submission form shows a **client-computed estimate** (page count via an
  in-browser PDF parse, sides/sheets via the same pure math used server-side) for instant
  feedback while choosing options. The authoritative page count, print math, and policy
  decision are only ever produced server-side in `app/print/actions.ts`, confirmed on the
  job status page immediately after submission - the frontend never overrides or
  pre-empts the server's decision.
- The policy rule builder (`app/admin/policies`) takes rule conditions as raw JSON rather
  than a full visual builder - the data model and engine (`packages/shared/src/policy-engine.ts`)
  are the same either way; a visual builder is a pure UI layer that can be added later.
- Realtime uses `postgres_changes` directly (simpler, still RLS-governed) rather than the
  private broadcast-channel pattern set up in `supabase/migrations/0008_realtime.sql` - see
  `docs/architecture.md` sec 3.4 for why both are secure and when you'd switch.
