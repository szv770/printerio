-- The live adjust_monthly_usage function had drifted from
-- 0010_quota_functions.sql: its "p_mode = 'reserve', p_limit is null ->
-- always succeed" branch was missing entirely, leaving only the final
-- guarded UPDATE ("... and (...) <= p_limit"). In SQL, `x <= NULL` evaluates
-- to NULL (not true), so a WHERE clause containing it matches ZERO rows -
-- meaning a null-limit reserve call (exactly what an admin-exempt
-- submission passes, per lib/policy/admin-bypass.ts) always affected 0 rows
-- and returned false, surfacing as "This job would exceed your monthly
-- print quota" for an org_admin whose jobs are supposed to never be quota-
-- blocked at all. Restoring the exact body from 0010_quota_functions.sql.
create or replace function adjust_monthly_usage(
  p_organization_id uuid,
  p_user_id uuid,
  p_period text,
  p_pdf_pages int,
  p_printed_sides int,
  p_physical_sheets int,
  p_color_weighted int,
  p_quota_basis text,
  p_limit int, -- null = no quota configured for this scope (always allowed)
  p_mode text  -- 'reserve' | 'release' | 'consume'
)
returns boolean
language plpgsql
as $$
declare
  v_rows int;
begin
  if p_mode not in ('reserve', 'release', 'consume') then
    raise exception 'invalid adjust_monthly_usage mode: %', p_mode;
  end if;

  insert into monthly_usage (organization_id, user_id, period)
  values (p_organization_id, p_user_id, p_period)
  on conflict (organization_id, user_id, period) do nothing;

  if p_mode = 'release' then
    update monthly_usage set
      reserved_pdf_pages = greatest(0, reserved_pdf_pages - p_pdf_pages),
      reserved_printed_sides = greatest(0, reserved_printed_sides - p_printed_sides),
      reserved_physical_sheets = greatest(0, reserved_physical_sheets - p_physical_sheets),
      reserved_color_weighted = greatest(0, reserved_color_weighted - p_color_weighted)
    where organization_id = p_organization_id and user_id = p_user_id and period = p_period;
    return true;
  end if;

  if p_mode = 'consume' then
    update monthly_usage set
      reserved_pdf_pages = greatest(0, reserved_pdf_pages - p_pdf_pages),
      reserved_printed_sides = greatest(0, reserved_printed_sides - p_printed_sides),
      reserved_physical_sheets = greatest(0, reserved_physical_sheets - p_physical_sheets),
      reserved_color_weighted = greatest(0, reserved_color_weighted - p_color_weighted),
      pdf_pages_used = pdf_pages_used + p_pdf_pages,
      printed_sides_used = printed_sides_used + p_printed_sides,
      physical_sheets_used = physical_sheets_used + p_physical_sheets,
      color_weighted_used = color_weighted_used + p_color_weighted
    where organization_id = p_organization_id and user_id = p_user_id and period = p_period;
    return true;
  end if;

  -- p_mode = 'reserve'
  if p_limit is null then
    update monthly_usage set
      reserved_pdf_pages = reserved_pdf_pages + p_pdf_pages,
      reserved_printed_sides = reserved_printed_sides + p_printed_sides,
      reserved_physical_sheets = reserved_physical_sheets + p_physical_sheets,
      reserved_color_weighted = reserved_color_weighted + p_color_weighted
    where organization_id = p_organization_id and user_id = p_user_id and period = p_period;
    return true;
  end if;

  update monthly_usage set
    reserved_pdf_pages = reserved_pdf_pages + p_pdf_pages,
    reserved_printed_sides = reserved_printed_sides + p_printed_sides,
    reserved_physical_sheets = reserved_physical_sheets + p_physical_sheets,
    reserved_color_weighted = reserved_color_weighted + p_color_weighted
  where organization_id = p_organization_id and user_id = p_user_id and period = p_period
    and (
      case p_quota_basis
        when 'pdf_pages' then pdf_pages_used + reserved_pdf_pages + p_pdf_pages
        when 'printed_sides' then printed_sides_used + reserved_printed_sides + p_printed_sides
        when 'physical_sheets' then physical_sheets_used + reserved_physical_sheets + p_physical_sheets
        when 'color_weighted' then color_weighted_used + reserved_color_weighted + p_color_weighted
        else physical_sheets_used + reserved_physical_sheets + p_physical_sheets
      end
    ) <= p_limit;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

comment on function adjust_monthly_usage is
  'Atomic quota reserve/release/consume - see docs/architecture.md sec 14. '
  'SECURITY INVOKER: runs as the caller, governed by monthly_usage RLS. '
  'Restored 2026-09-08 after the live function drifted from '
  '0010_quota_functions.sql and lost its null-limit-always-succeeds branch.';
