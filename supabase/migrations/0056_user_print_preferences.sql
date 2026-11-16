-- Printio: one small per-user preferences row for the print page ("Remember my last print choices").
-- Additive only and re-runnable: one new table, nothing existing is touched. The app works WITHOUT this table
-- (a missing table just means the setting is off), so applying it is never urgent.
--
--   remember_last  false (default): the print page starts clean every time. true: it starts from last_choices.
--   last_choices   what the person chose when they last submitted a job (only written while remember_last is true).
--                  A small jsonb object; the app validates everything it reads back and ignores what it does not understand.
--
-- Access: a person reads, adds and changes ONLY their own row (user_id = auth.uid()). Nobody reads another user's
-- row, in the same school or another. No delete policy (the row goes with the profile). Nothing for anon.
-- The default privileges (0031) hand new tables to signed-in members, so the revokes below take back what is not needed.

create table if not exists public.user_print_preferences (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  remember_last boolean not null default false,
  last_choices jsonb check (last_choices is null or (jsonb_typeof(last_choices) = 'object' and octet_length(last_choices::text) <= 2000)),
  updated_at timestamptz not null default now()
);

alter table public.user_print_preferences enable row level security;

drop policy if exists "users read their own print preferences" on public.user_print_preferences;
create policy "users read their own print preferences"
  on public.user_print_preferences for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "users add their own print preferences" on public.user_print_preferences;
create policy "users add their own print preferences"
  on public.user_print_preferences for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "users change their own print preferences" on public.user_print_preferences;
create policy "users change their own print preferences"
  on public.user_print_preferences for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke delete, truncate, references, trigger on public.user_print_preferences from authenticated;
revoke all on public.user_print_preferences from anon;
grant select, insert, update on public.user_print_preferences to authenticated, service_role;
