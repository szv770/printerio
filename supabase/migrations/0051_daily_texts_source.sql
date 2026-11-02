-- Printio: the daily study text now also comes from the Chitas & Rambam booklet page (chitas-site.vercel.app), the builder Chabad.org
-- pointed the owner to, because Chabad.org's own pages show automated visitors a Cloudflare check. Allow its address as a source.
-- Re-runnable.

alter table public.library_daily_texts drop constraint if exists library_daily_texts_source_url_check;
alter table public.library_daily_texts
  add constraint library_daily_texts_source_url_check
  check (source_url ~ '^https://(www[.]chabad[.]org/dailystudy|chitas-site[.]vercel[.]app/shiur)[A-Za-z0-9_./?=&%-]{0,300}$');
