-- One-off data fix: first_printed_at was never set (the agent status route did not stamp it), so every device showed
-- "sent a print, not printed yet". New prints now stamp it (apps/web agent status route). This back-fills devices whose
-- jobs already completed. Data only: no schema change, safe to re-run.
update public.member_devices d
set first_printed_at = j.first_done
from (
  select device_id, min(coalesce(completed_at, created_at)) as first_done
  from public.print_jobs
  where device_id is not null and status = 'completed'
  group by device_id
) j
where d.id = j.device_id and d.first_printed_at is null;
