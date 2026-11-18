-- Printio: weeks of Sichos In English (SIE Weekly) added after the saved copy in the code.
--
-- The library has a saved copy of SIE's weekly list (apps/web/lib/library/sie-weekly.ts). When SIE publishes new weeks, an
-- org admin presses "Check for new weeks" in the library; Printio reads SIE's public weekly page, reads each new file's
-- first and last pages, and stores the new entries here. Everyone who may use the library then sees them.
-- Only the service role writes (the admin action checks the role first); signed-in members can read. Re-runnable.

create table if not exists public.library_sie_entries (
  url text primary key
    check (url ~ '^https://drive[.]google[.]com/file/d/[A-Za-z0-9_-]{20,}/view$'),
  chelek text not null check (char_length(chelek) between 1 and 20),
  sefer text not null check (char_length(sefer) between 1 and 30),
  title text not null check (char_length(title) between 1 and 120),
  -- Which Likkutei Sichos sicha it translates, read from the file's first page (null when it could not be read).
  volume int check (volume is null or volume between 1 and 99),
  page int check (page is null or page between 1 and 5000),
  -- The file's real content: it opens with a cover, a blank page and dedication page(s), and ends with a blank page,
  -- a copyright credits page and a back cover, all left out.
  from_page int not null default 1 check (from_page between 1 and 50),
  to_page int check (to_page is null or to_page between 1 and 1000),
  page_count int check (page_count is null or page_count between 1 and 1000),
  added_at timestamptz not null default now(),
  added_by uuid references public.profiles (id) on delete set null
);

alter table public.library_sie_entries enable row level security;

drop policy if exists "members can read the SIE list" on public.library_sie_entries;
create policy "members can read the SIE list"
  on public.library_sie_entries for select
  to authenticated
  using (true);

-- Read for signed-in members; every write goes through the service role (never anon).
-- The default privileges (0031) also hand new tables to signed-in members; take the writes back so only the service role writes.
revoke insert, update, delete, truncate, references, trigger on public.library_sie_entries from authenticated;
revoke all on public.library_sie_entries from anon;
grant select on public.library_sie_entries to authenticated;
grant select, insert, update, delete on public.library_sie_entries to service_role;
