# Printio - notes for Claude

Multi-tenant print management: Next.js cloud app (`apps/web`, Vercel + Supabase) + on-prem Windows
Print Agent (`apps/agent`, polls the cloud, prints via SumatraPDF to Windows queues -> Kyocera TASKalfa
MZ8500i) + shared logic (`packages/shared`: policy engine, job state machine, print math).
Currently a single-org prototype on a full multi-tenant schema. Start at `README.md` and `docs/`.

## Commands (pnpm 10, Node 20+)
- `pnpm install --frozen-lockfile`, then `pnpm -r typecheck | lint | test | build` (CI runs exactly these).
- One package: `pnpm --filter @printio/web test` (also `@printio/agent`, `@printio/shared`).
- New dependencies change `pnpm-lock.yaml`; CI uses `--frozen-lockfile`. Keep experiments outside
  `apps/*` / `packages/*` (workspace globs) unless they are meant to be workspace packages.
- Supabase migrations in `supabase/migrations` (numbered, source of truth); `schema.sql` is a reference dump.

## Current focus: native printing from the OS print dialog (read before touching)
Design + decisions + findings: `docs/ipp-printing.md`. Kyocera driver wire capture and the raw-port
experiment: `docs/kyocera-raw-print.md`. Throwaway IPP test server: `tools/ipp-spike/` (no deps,
`node --test`, README has the Pi + Cloudflare steps). Do not re-derive these; extend them.
Next steps are listed at the bottom of `docs/ipp-printing.md` (Apple tests, Chromebook check, raw-print
replay, then Phase 1 gateway).

## Gotchas
- Supabase Data API grants (Supabase's Oct 30, 2026 change): new tables in `public` no longer get
  automatic Data API grants. Every migration that creates a table must include an explicit
  `grant select, insert, update, delete on public.<table> to authenticated, service_role;` - never
  `anon`; RLS stays the row-access layer. `0031_explicit_table_grants.sql` made the existing grants
  explicit and set `alter default privileges` as a backstop, but still write the grant in each new
  table's migration so the access decision stays reviewable (and revoke from `authenticated` when a
  table is service-role-only). Mirror each migration into `schema.sql` as before.
- PRs: the repo's default branch is `claude/upcoming-large-project-3d2j9p` (there is no `main`).
- `apps/web/lib/pdf/imposition.test.ts` "byte-identical" test is timing-flaky (pdf-lib stamps the
  current time; fails across a clock-second boundary). A re-run passes; the proper fix is fixed dates.
- Vercel bot comments on PRs are noise. Docs/tools-only PRs do not affect the web build.
- Never commit secrets, tunnel tokens, or the spike's `spike-data/` (gitignored).

## How the owner likes to work
- Ask clarifying questions before building, especially on detailed behavior; give a recommendation,
  not a survey. Split independent work across agents when it genuinely helps.
- Keep usage low: read the docs above instead of re-exploring the repo, grep narrowly, don't dump
  big files, summarize results briefly. Prefer small tests that prove one thing.
- The owner tests on real devices (Pi + Pixel 8 + Windows 11 + Chromebook; Apple only by borrowing):
  give exact copy-paste steps and say plainly what is untested.
