# Deployment

This covers standing up the Supabase project PrintOS depends on and deploying
`apps/web` to Vercel. It assumes you have already read
[architecture.md](./architecture.md) sections 2–4 and 16 (auth/bootstrap model,
RLS, deployment shape) — this document is the "how," that one is the "why."

## 1. Supabase project setup

1. Create a new Supabase project (dashboard, or `supabase projects create` /
   the Supabase MCP tooling if you're using it from an agent session).
2. Apply the migrations in `supabase/migrations/` **in order** — they are
   numbered (`0001_core_tables.sql` … `0009_lint_fixes.sql`) and each depends on
   the ones before it (table creation, then extensions/helpers, then RLS
   policies, then storage, then realtime). The two supported ways to apply them:
   - `supabase db push` (or `supabase migration up` against a linked project)
     from a machine/CI with the Supabase CLI, pointed at this repo's
     `supabase/migrations/` directory.
   - The Supabase Dashboard's SQL editor, pasting each migration file's contents
     in numeric order, or the Supabase MCP `apply_migration` tool if your
     session has it attached.
3. `supabase/schema.sql` is a **consolidated reference dump** of the resulting
   schema — useful for a fast read of "what does the database actually look like
   right now" without walking nine files, but it is **not** what you run to
   provision a project. The numbered migrations in `supabase/migrations/` remain
   the source of truth; if `schema.sql` and the migrations ever disagree, the
   migrations win (open an issue/fix `schema.sql`, don't hand-edit the live
   database to match a stale dump).

## 2. Manual one-time dashboard steps

These are steps Supabase does not expose as SQL you can put in a migration —
they must be done once, by hand, in the dashboard (or via the platform
management API, if you're scripting a new environment).

### 2.1 Enable Google as an OAuth provider

PrintOS's bootstrap model (architecture.md sec 2.2) relies on Google OAuth sign-in
— there is deliberately no email/password path and no "first user from an allowed
domain becomes admin" logic.

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or
   reuse) an OAuth 2.0 Client ID of type "Web application."
2. Add an authorized redirect URI of the form:
   ```
   https://<project-ref>.supabase.co/auth/v1/callback
   ```
   (replace `<project-ref>` with your Supabase project's ref, visible in the
   dashboard URL and in Project Settings → General).
3. In the Supabase Dashboard: **Authentication → Providers → Google**, toggle
   it on, and paste in the Client ID and Client Secret from step 1–2.
4. If `apps/web` is deployed at a custom domain, also add that domain's own
   callback path if Supabase Auth is configured to redirect back through it
   (check Authentication → URL Configuration → Redirect URLs); otherwise the
   `<project-ref>.supabase.co` callback above is sufficient since Supabase Auth
   handles the OAuth round-trip itself before handing a session back to the app.

### 2.2 Disable "Allow public access" under Realtime

Per architecture.md sec 3.4: all PrintOS Realtime channels are `private: true`
and authorized by RLS policies on `realtime.messages` (see
`supabase/migrations/0008_realtime.sql`). As defense in depth on top of those
policies, also disable public/unauthenticated channel access at the project
level:

**Realtime → Settings → "Allow public access"** → off.

This is not expressible as SQL/migration; it's a project-level Realtime setting.
Without it, the RLS policies are still the real enforcement point, but a
misconfigured client-side `{ config: { private: false } }` subscribe call would
otherwise be able to join an unauthorized public channel at all — this setting
removes that option project-wide.

### 2.3 Custom Access Token Hook

Architecture.md sec 2.3 describes stamping the caller's active organization id +
role into the JWT via a Supabase **Custom Access Token Hook**, so RLS and
Realtime channel authorization can check `auth.jwt()` cheaply instead of a
per-request lookup. If/when this hook function is added to the migrations, wire
it up once in the dashboard:

**Authentication → Hooks → Custom Access Token** → select the hook function →
enable.

Until this hook is configured, RLS policies that use `private.user_org_ids()`
etc. (architecture.md sec 3.1) work correctly on their own by querying
`organization_members` directly — the hook is a latency optimization for
claims-based checks, not a prerequisite for RLS to function. Confirm against the
actual migration set whether a `custom_access_token_hook` function exists yet
before assuming this step applies to your deployment.

### 2.4 Enable Email as an auth provider (magic-link sign-in)

Magic-link (email OTP) sign-in (architecture.md sec 19.3) relies on Supabase's built-in
**Email** provider — same category of manual step as 2.1's Google OAuth client-id setup,
except there's no external OAuth client to create; it's purely a dashboard toggle:

1. In the Supabase Dashboard: **Authentication → Providers → Email**, toggle it on.
2. Leave "Confirm email" per your own project's needs — magic-link sign-in (`signInWithOtp`)
   works the same either way; that setting affects password-based signup, not the OTP link
   flow this app uses.
3. No redirect URI step is needed here (unlike 2.1's Google setup) — `emailRedirectTo` is
   passed directly in the `signInWithOtp()` call (`app/login/MagicLinkForm.tsx`) and just
   needs to be an allowed redirect URL under **Authentication → URL Configuration**, same as
   the Google flow's callback already requires.

## 3. Environment variables (`apps/web`)

| Variable | Where used | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Browser + server | Project URL, safe to expose client-side. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser + server | Anon/publishable key; RLS is the actual enforcement point, so this being public is expected and safe. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | **Never** prefix with `NEXT_PUBLIC_`. Used only in the small, explicit set of service-role operations described in architecture.md sec 3 (invitation redemption, agent registration, cross-tenant super-admin provisioning) — isolated to `apps/web/lib/supabase/service-role.ts` per that section, never imported into a client component. |
| `PRINTOS_BOOTSTRAP_ADMIN_EMAIL` | Server (one-time bootstrap) | The email of the person who becomes the first `org_admin` of the first organization, per the super-admin bootstrap path in architecture.md sec 2.2. This email's own domain also seeds that organization's `allowed_domains` (architecture.md sec 19) — no separate env var is needed for domain-restricted sign-in; an org_admin can widen/narrow/clear the list afterward from `/admin/settings`. |
| `PRINTOS_BOOTSTRAP_ORG_NAME` | Server (one-time bootstrap) | Name of the organization created by that same bootstrap path. |
| `PRINTOS_CRON_SECRET` | Server only | Shared secret Vercel Cron (or any external caller) presents as `Authorization: Bearer <value>` to `/api/cron/sweep`. Generate a random string. |

`apps/web` has no application code checked into this repository yet (see the
root [README.md](../README.md) "Current status & next phase"), so this list is
derived from the auth/bootstrap model in architecture.md sec 2 rather than read
from an existing `.env.example`. **Confirm the exact variable names against
`apps/web/.env.example` once that file exists** — a later pass over this repo
should reconcile this table against the real file rather than trust it blindly.

## 4. Deploying `apps/web` to Vercel

`apps/web` lives inside a pnpm workspace monorepo, so Vercel's default
"detect the app in the repo root" build does not work unmodified. Two
equivalent approaches (Vercel's exact UI wording shifts over time, so this is
described conceptually):

**Approach A — Root Directory + "Include files outside the root directory."**
Set the Vercel project's **Root Directory** to `apps/web`, and enable the
option (usually under Project Settings → General, sometimes surfaced during
import) that lets the build context reach outside that root directory so pnpm
can resolve workspace dependencies (`@printos/shared`, and the workspace's
lockfile at the repo root). Vercel's monorepo support is generally good at
auto-detecting a pnpm workspace once the root directory is set this way; verify
the build actually resolves `@printos/shared` rather than assuming it does.

**Approach B — Root Directory left at repo root, explicit build command.**
Leave the Vercel project's Root Directory at the repository root and set an
explicit Build Command that installs from the workspace root and builds only
the web app, e.g.:
```
cd . && pnpm install --frozen-lockfile && pnpm --filter @printos/web build
```
(adjust the `cd` as needed depending on where Vercel's build actually starts —
some Vercel monorepo setups start the build already inside the chosen root, in
which case the equivalent is `cd ../.. && pnpm install && pnpm --filter @printos/web build`
to get back to the workspace root first). Set the **Output Directory** to
`apps/web/.next` (Next.js default) and confirm the **Install Command** isn't
separately overridden to something that skips the workspace root.

Either way:
- Set all environment variables from §3 in the Vercel project's Environment
  Variables settings (scope `SUPABASE_SERVICE_ROLE_KEY` to server-only —
  Vercel doesn't have a separate "server-only" toggle beyond simply never
  prefixing it `NEXT_PUBLIC_`, but do not add it to any client-bundled config).
- Use Node.js 20+ as the Vercel project's Node version (matches
  `package.json`'s `engines.node`).

## 5. Vercel Cron for the retention/lease-expiry sweep

Architecture.md sec 16 describes periodic sweeps (expiring stale approval
windows/leases per architecture.md sec 13, enforcing file retention per the
`organization_settings.retention_*` columns) running as Vercel Cron hitting a
Route Handler — a straightforward idempotent "scan and expire" pass, not a
queue/workflow system.

Convention to follow once `apps/web` has code: a Route Handler at
`app/api/cron/sweep/route.ts`, invoked by a `vercel.json` entry such as:

```json
{
  "crons": [
    { "path": "/api/cron/sweep", "schedule": "*/15 * * * *" }
  ]
}
```

(every 15 minutes is a reasonable starting cadence given `job_lease_minutes`
defaults to 10 — adjust once real lease/approval-expiry durations are tuned).
Vercel Cron authenticates its own requests via a shared secret header -
`PRINTOS_CRON_SECRET` (add it to your environment variables; the route checks
`Authorization: Bearer <PRINTOS_CRON_SECRET>`) rather than a user session.
This is the real, implemented route (`apps/web/app/api/cron/sweep/route.ts`)
and `vercel.json` cron entry - not a placeholder.

## 6. Post-deploy smoke test

After deploying, before trusting the environment for real use:

1. **Sign in** with the Google account configured as
   `PRINTOS_BOOTSTRAP_ADMIN_EMAIL` and confirm the bootstrap flow actually
   created the organization (`organizations` row) and the `organization_members`
   row linking that account as `org_admin` — check the dashboard shows an org
   context immediately after first sign-in, not an empty/broken state.
2. **Confirm RLS is actually enforced**, not just configured: create a second
   organization + second user (see [testing.md](./testing.md) for the full
   manual RLS checklist), sign in as that second user, and confirm you
   **cannot** see the first organization's jobs, printers, or files — an empty
   list/404, not an error page that leaks data. This is the single most
   important smoke test for a multi-tenant system; do not skip it because the
   migrations "look right."
3. Confirm Realtime actually delivers: open the approval queue as an admin in
   one browser session, approve/reject a job from another, and confirm the
   first session's queue updates without a manual refresh (architecture.md
   sec 3.4, sec 15).
