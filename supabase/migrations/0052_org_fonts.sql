-- Printio: Hebrew fonts an org admin uploads, so daily-study booklets can be set in them (for example SBL Hebrew).
--
-- We may not bundle such fonts in the repo for licence reasons, so each organization brings its own. The font bytes live in a
-- private Storage bucket (org-fonts) and are only ever read by the server, which draws the glyphs into the organization's PDFs;
-- nothing hands the file back to a browser. Members can read the list (name and what the font covers) so the booklet form can
-- offer it; every write (upload, delete) goes through the service role after an org_admin check. Re-runnable.
-- Path convention in the bucket: org/{organizationId}/{fontId}.font

create table if not exists public.org_fonts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Display name, taken from the font's family name.
  name text not null check (char_length(name) between 1 and 80),
  file_name text,
  storage_path text,
  size_bytes integer,
  has_vowels boolean not null default false,
  has_cantillation boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);

create index if not exists org_fonts_organization_id_idx on public.org_fonts (organization_id);

alter table public.org_fonts enable row level security;

drop policy if exists "members can read their org's fonts" on public.org_fonts;
create policy "members can read their org's fonts"
  on public.org_fonts for select
  to authenticated
  using (organization_id in (select private.user_org_ids()));

-- Read for the organization's members; every write goes through the service role (never anon).
-- The default privileges (0031) also hand new tables to signed-in members; take the writes back so only the service role writes.
revoke insert, update, delete, truncate, references, trigger on public.org_fonts from authenticated;
revoke all on public.org_fonts from anon;
grant select on public.org_fonts to authenticated;
grant select, insert, update, delete on public.org_fonts to service_role;

-- Private bucket, 8 MiB per file. No policies for authenticated or anon: only the service role reaches it.
insert into storage.buckets (id, name, public, file_size_limit)
values ('org-fonts', 'org-fonts', false, 8388608)
on conflict (id) do update set public = false, file_size_limit = 8388608;
