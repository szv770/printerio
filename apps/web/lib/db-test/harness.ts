import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Test-only: an in-memory Postgres (PGlite, pure WASM) with just enough of
 * Supabase stubbed (roles, auth.users/uid()/role(), storage, realtime) to
 * replay the REAL supabase/migrations/*.sql in order. Lets us prove RLS,
 * grants and the join-policy functions instead of only reading SQL.
 *
 * It is NOT Supabase: no GoTrue, no PostgREST. Roles are emulated with
 * `set role` + the `request.jwt.claims` setting, which is how PostgREST does it.
 */
const MIGRATIONS_DIR = path.resolve(__dirname, "../../../../supabase/migrations");

const SUPABASE_STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator nologin;
create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
grant usage on schema auth to anon, authenticated, service_role;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as
  $$ select string_to_array(name, '/') $$;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
create publication supabase_realtime;
create schema realtime;
create table realtime.messages (id uuid default gen_random_uuid(), extension text, topic text);
alter table realtime.messages enable row level security;
create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
grant usage on schema realtime to authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase's default privileges on public (the source of F11): everything to everyone.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

export interface Db {
  pg: PGlite;
  /** Run SQL as a Supabase role (anon / authenticated / service_role), optionally as a user. */
  as<T = Record<string, unknown>>(
    role: "anon" | "authenticated" | "service_role",
    userId: string | null,
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  /** Run SQL as the superuser (setup/assertions only). */
  admin<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
}

export async function createDb(opts: { upTo?: string; skip?: string[] } = {}): Promise<Db> {
  const pg = new PGlite({ extensions: { pgcrypto } });
  await pg.exec(SUPABASE_STUBS);
  for (const file of migrationFiles()) {
    if (opts.upTo && file > opts.upTo) break;
    if (opts.skip?.includes(file)) continue;
    try {
      await pg.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
    } catch (e) {
      throw new Error(`migration ${file} failed in PGlite: ${(e as Error).message}`);
    }
  }
  const run = async <T,>(sql: string, params?: unknown[]) => (await pg.query<T>(sql, params)).rows;
  return {
    pg,
    admin: run,
    async as<T>(role: string, userId: string | null, sql: string, params?: unknown[]) {
      await pg.exec(`set role ${role}`);
      await pg.exec(`select set_config('request.jwt.claim.role', '${role}', false), set_config('request.jwt.claim.sub', '${userId ?? ""}', false)`);
      try {
        return await run<T>(sql, params);
      } finally {
        await pg.exec(`reset role`);
      }
    },
  };
}
