-- Printio: the text of Chabad.org's daily study (Chumash with Rashi, Tanya, Rambam), kept once per day and study.
--
-- Chabad.org's pages sit behind a Cloudflare check that we never get past. A person opens the page in their own browser and
-- sends it to Printio ("Import from my browser", an org admin), or a slow fetch on the print server PC saves it when the site
-- lets it through. The text is stored here (Hebrew and English side by side, no footnotes, no quiz) so everyone in the library
-- can print it without touching Chabad.org again. See docs/daily-study.md.
-- Only the service role writes (the action checks the admin role first); signed-in members can read. Re-runnable.

create table if not exists public.library_daily_texts (
  study text not null check (study in ('chumash', 'tehillim', 'tanya', 'hayomyom', 'mitzvah', 'rambam1', 'rambam3')),
  study_date date not null,
  portion text not null check (char_length(portion) between 1 and 300),
  -- [{ heading, blocks: [{ kind, num, he, en, leadHe, leadEn }] }], as read by lib/library/daily/page.ts.
  sections jsonb not null check (jsonb_typeof(sections) = 'array' and octet_length(sections::text) <= 1500000),
  source_url text not null check (source_url ~ '^https://www[.]chabad[.]org/dailystudy/[A-Za-z0-9_./?=&%-]{1,200}$'),
  fetched_at timestamptz not null default now(),
  added_by uuid references public.profiles (id) on delete set null,
  primary key (study, study_date)
);

alter table public.library_daily_texts enable row level security;

drop policy if exists "members can read the daily study" on public.library_daily_texts;
create policy "members can read the daily study"
  on public.library_daily_texts for select
  to authenticated
  using (true);

-- Read for signed-in members; every write goes through the service role (never anon).
-- The default privileges (0031) also hand new tables to signed-in members; take the writes back so only the service role writes.
revoke insert, update, delete, truncate, references, trigger on public.library_daily_texts from authenticated;
revoke all on public.library_daily_texts from anon;
grant select on public.library_daily_texts to authenticated;
grant select, insert, update, delete on public.library_daily_texts to service_role;
