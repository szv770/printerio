# Tenant isolation tests (two-school test)

Phase A "safety net" of `docs/TARGET-ARCHITECTURE.md`. It proves, in CI, that one school (organization) cannot read or change
another school's data through the **database rules** (row-level security, grants, trigger rules, function permissions) before more
schools are added. It runs with the normal `pnpm --filter @printio/web test` (about 8 seconds in total).

Files (all in `apps/web/lib/db-test/tenant-isolation/`):

| File | What it is |
|---|---|
| `fixture.ts` | Replays every real migration into PGlite (in-memory Postgres), then seeds **School A** and **School B**: for each an admin, an approver and a member, plus a row in every table (printer, profiles, agent, jobs, events, quota, policy and rule, device, invitation, font, group, audit row, remote command...). Also one signed-in user with no school. Test-only; nothing touches a real database. |
| `expected-access.ts` | **The expected-access table**: one entry per table saying who may read and write it, and why (a comment per table). Also the list of foreign-key attacks and the open gaps. |
| `isolation.db.test.ts` | The matrix: every table x 7 callers x select/insert/update/delete, plus the "move a row into the other school" and foreign-key attacks. |
| `functions-columns.db.test.ts` | SQL functions (EXECUTE rights, SECURITY DEFINER, search_path), secret columns, defaults for future tables and functions, Realtime and Storage policy logic, which tables are streamed over Realtime. |

## What is proven

- **28 tables** in `public`, all with row-level security on. `anon` holds no privilege on any table and no policy is open to `anon` or PUBLIC.
- **7 callers** for each table: School A admin, School A approver, School A member, School B admin, School B member, a signed-in user with no school, and anon.
- **4 operations** each (select, insert, update, delete), roughly 2,500 real statements, each in a transaction that is rolled back.
  - Select: the set of rows each caller sees must equal exactly the expected set. A single School B row visible to a School A caller fails the test.
  - Insert: allowed only for the stated role in its own school, never aimed at the other school, never for a no-school user or anon.
  - Update / delete: tried on **every row of both schools** as every caller; allowed only where the table says so, never across schools. Updates that try to move a row into the other school (`organization_id` changed) are refused everywhere.
  - Tables nobody signed in may write (print jobs, devices' events, org fonts, usage counters...) are proven writable by the service role with the same statement, so the denial is real and not a typo.
- **Shared library tables** (`library_daily_texts`, `library_sie_entries`): readable by every signed-in user, asserted explicitly; writable by nobody except the service role.
- **Foreign-key attacks** (a legitimate admin of School A, own `organization_id`, but pointing at a School B object): 24 are blocked (queue profiles, policy rules, group members, approvals, job events, device reports, devices, invitations with a School B group, forged "issued by" and "actor" ids, platform_role escalation, email change, un-revoking a device...). 7 cases (5 distinct holes) are **open gaps** (below).
- **Functions**: every function in `public` and `private` is listed with its SECURITY DEFINER flag; every SECURITY DEFINER function has an empty fixed `search_path`; anon and signed-in users hold no EXECUTE on any `public` function (every RPC goes through the server's service role); each function is actually called as anon, School A admin, School A member and no-school user with School B's ids and is refused, while the service role can still call it; `private.*` helpers cannot be reached (no schema usage). No function takes an organization id from a caller who is not the server.
- **Secret columns**: `member_devices.token_hash` is unreadable by anon, by every signed-in user and cannot be updated; `select *` on `member_devices` fails. Every column whose name looks like a secret (hash, secret, token, password, credential, key, enrollment, `*_code`) must be reviewed in `COLUMN_SECRETS`.
- **Defaults for the future**: a new table gives nothing to anon; a new table has no TRUNCATE/REFERENCES/TRIGGER for signed-in users.
- **Realtime and Storage policy logic**: broadcast channels `org-<id>:...` only for active members of that school (read and send), no presence/other messages; print-job files readable only by the job's creator or the school's approvers/admins, spoofed paths (School A folder with a School B job id) match nobody, nobody can upload/update/delete directly; the bucket is private; only `agents`, `print_jobs` and `remote_commands` are published to Realtime and all have RLS.

## Expected-access table (summary)

Full reasons are in `expected-access.ts`. "own" = rows the person owns (their jobs, devices, profile). Writes show the lowest role allowed; "server" = nobody signed in, only server code (service role).

| Table | Read (admin / approver / member) | Insert | Update | Delete |
|---|---|---|---|---|
| agents, invitations, policy_rules, print_policies, quotas, remote_commands, audit_logs | admin only (approver and member see nothing) | admin | admin (audit_logs: never) | admin (remote_commands, audit_logs: never) |
| groups, group_members, printers, printer_profiles, organization_settings, organization_members, setup_confirmations | all / all / all (the school's own rows) | admin | admin (setup_confirmations: never) | admin |
| organizations | own school only | server | admin | server |
| print_jobs, print_job_events, approval_actions | all / all / own | server (events: member on a job they can act on; approvals: approver) | server | server |
| member_devices | all / own / own | member (self) | member, own only (name, revoked) | server |
| device_events, device_connection_tests, device_issues, device_setup_feedback, monthly_usage | all / own / own | server (issues and feedback: member, own device) | server (issues: admin) | server (usage: admin) |
| profiles | all / all / own | server | member, own only | server |
| org_fonts | all / all / all | server | server | server |
| library_daily_texts, library_sie_entries | every signed-in user | server only | server | server |

## How to add a table (the test fails until you do)

1. Write the migration as usual (RLS on, explicit `grant` to `authenticated, service_role`, never `anon`, per `CLAUDE.md`).
2. Run `pnpm --filter @printio/web test`. `coverage > every table in public has an entry` fails and names the table.
3. In `expected-access.ts` add an entry: `why` (plain words), `school` (SQL that gives the row's organization id, e.g. `t.organization_id` or a subselect through its parent), `owner` if rows belong to a person, `select` per role (`all` / `own` / `none`), `insert` / `update` / `delete` (lowest role or `none`), and `makeInsert` (one valid row aimed at a target school).
4. Add one seed row per school to `seed()` in `fixture.ts` (the "fixture has data for both schools" test tells you if you forget).
5. If the table points at another table with a foreign key the policy does not check, add an entry to `ATTACKS`.
6. A new function: add it to `FUNCTIONS` (and a probe in `CALLS` if it lives in `public`). A new secret-looking column: add it to `COLUMN_SECRETS`. A new Realtime-published table: update the publication test.

## Open gaps (found by this test, not fixed here; migrations were not touched)

Each is marked `it.fails` plus a "still reproducible" case, so CI is green while it is open and **goes red the day it is fixed** (then remove the markers).

1. **High** `remote_commands`: insert/update only check `organization_id` and `issued_by`, not that `agent_id` belongs to the same school. The agent poll (`app/api/agents/commands/route.ts`) filters by `agent_id` only, and the ack route (`.../ack/route.ts`) writes the result into the row, which the sending school's admin can read. So School A's admin who knows a School B agent id (random uuid) can make School B's print server run an allow-listed command (restart service, get logs, check for update) and read the result. Fix: policy check that the agent (and printer) belong to the row's school.
2. **Medium** `printer_profiles` (insert and update): policies check only the printer's school, so `agent_id` can be another school's agent. Jobs are still filtered by the agent's own school today, so no document crosses, but the database does not enforce it.
3. **Medium** `organization_members` insert: School A's admin can enrol any existing user id (including a School B user) into School A without consent, then read that user's name and email through the profiles policy. Needs the user's uuid (not listed anywhere). Fix: invite/accept flow, or limit inserts to users who accepted.
4. **Low** `group_members` insert: `user_id` may be someone who is not a member of the school (integrity only).
5. **Low** `remote_commands.printer_id` is not checked against the school (integrity only).
6. **Low** `agents.device_secret_hash`: signed-in users hold table-level SELECT, so a school's own admins can read it (never another school). Also part of the Realtime-published table. Fix: column-level grants as `member_devices` has.
7. **Low (preventive)**: a function created by a future migration is executable by anon and signed-in users (Postgres gives EXECUTE to PUBLIC and 0040's default privileges only name anon/authenticated). Fix: `alter default privileges in schema public revoke execute on functions from public;`. Also by design (0031) a new table gives signed-in users select/insert/update/delete, so a table created without RLS is wide open; the RLS test catches that.

Observations, not gaps: `agents.enrollment_code` is stored in plain text and shown to the school's admins on purpose; `adjust_monthly_usage`, `claim_invitation_use` and `join_org_by_domain` take organization/user/invitation ids from their arguments, which is safe only because just the service role can execute them (asserted).

## What is NOT covered (cannot be tested in PGlite, or is outside the database rules)

- **The server code uses the service role** for most writes, which bypasses every rule tested here. Isolation there depends on each route/action checking the caller's school; this test cannot see it. (Every route would need its own test, or move reads and writes to the user's own session.)
- **Storage buckets**: only the SQL policies on `storage.objects` are tested, against a stub table. Not tested: that the bucket really is private in the project, signed-URL expiry, size and type limits, and the real `storage.foldername()` (the stub returns every path part including the file name; the policies only index the first four parts, so results match).
- **Realtime**: the SQL policies on `realtime.messages` are tested with `realtime.topic()` stubbed from a setting. Not tested: that "Allow public access" is switched off in the dashboard, that the Realtime server really applies RLS to `postgres_changes` per subscriber, filters on a channel, and rate limits.
- **PostgREST and GoTrue**: no JWT parsing (the test sets `request.jwt.claim.sub/role`, which is what the policies read), no exposed-schema setting (`private` must not be in "Exposed schemas"), no auth hooks (`email_domain_allowed*` run as a hook role there).
- **Service-role key handling**, tunnels, the agent and gateway code.

### Manual check on a real Supabase test project

Use a throwaway project (never production): apply the migrations, create two users in two schools, then
1. in Settings > API confirm Exposed schemas is `public` only and the `anon` key cannot `select` any table (`curl .../rest/v1/profiles` with the anon key must be 401/permission denied);
2. with School A's user JWT call `rest/v1/<table>?select=*` for every table and `rest/v1/rpc/<each function>`; expect only School A rows and no function allowed;
3. Realtime: with School A's JWT subscribe to `org-<B id>:jobs` (must be refused) and to `postgres_changes` on `print_jobs` (must deliver only School A rows); confirm "Allow public access" is off;
4. Storage: with School A's JWT try to download and to create a signed URL for a School B job path, and upload anywhere in `print-jobs` (all must fail);
5. repeat the open gaps above to confirm they behave as in PGlite, and again after any fix.


## Update 2026-11-15: gaps fixed by migration 0054
The first run found real gaps (kept as expected failures until fixed). Migration `0054_tenant_isolation_fixes.sql` closes six of them and their cases are now ordinary "must be blocked" checks, so a regression turns CI red:
- `remote_commands` insert and update: the target agent (and printer) must belong to the same school (**was HIGH**).
- `printer_profiles` insert and update: the profile's agent must belong to the same school as its printer.
- `organization_members` insert: the admin insert rule was dropped and the INSERT grant revoked from signed-in users; members are enrolled by server code only (invitation claim and platform console use the service role). The matrix level for that insert is now `none`.
Why this is safe: the website already checked the agent and printer in its own code before writing (`lib/remote-commands.ts`, `app/admin/printers/actions.ts`; the printer code's comment even said RLS also enforced it, which it did not), and both member-enrolment paths use the service role, which bypasses these rules.
Still open (low): `group_members.user_id` and the secret-hash column readability, and the preventive function-grant default; see the table above and the `gap` entries in `expected-access.ts`.

## Status of migration 0054 on the live database (2026-11-15)
The tests run against the migration FILES in CI, so they pass with 0054 included. The live Supabase database does **not** have 0054 yet (the connector's confirmation prompt timed out four times); see `docs/STATE-2026-11-01.md`. Until it is applied the live rules still have the gaps listed above (needs another school's random server id, and only one school exists today).

