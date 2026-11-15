-- Printio: an uploaded font can now cover Hebrew, English (Latin) letters, or both.
--
-- Until now every uploaded font had to have Hebrew (0052), so existing rows are Hebrew fonts. English fonts (for the English text of
-- the daily study and booklets) are uploaded on the same page; the flags say what each font can be chosen for. No new table, so the
-- grants from 0052 (read for members, writes for the service role) stay as they are. Re-runnable.

alter table public.org_fonts add column if not exists has_hebrew boolean not null default true;
alter table public.org_fonts add column if not exists has_latin boolean not null default false;
