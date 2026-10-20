-- Raw-port output: send jobs straight to the printer (TCP 9100, PJL + PDF)
-- instead of a Windows queue. See docs/kyocera-raw-print.md.
alter table public.printer_profiles
  add column if not exists output_mode text not null default 'queue'
    check (output_mode in ('queue', 'raw')),
  add column if not exists raw_host text,
  add column if not exists raw_port integer not null default 9100
    check (raw_port between 1 and 65535),
  add column if not exists raw_staple_position text not null default 'top-left'
    check (raw_staple_position in ('top-left', 'top-right'));

alter table public.printer_profiles
  alter column windows_queue_name drop not null;

alter table public.printer_profiles
  add constraint printer_profiles_output_target_check
  check (
    (output_mode = 'queue' and windows_queue_name is not null)
    or (output_mode = 'raw' and raw_host is not null)
  );
