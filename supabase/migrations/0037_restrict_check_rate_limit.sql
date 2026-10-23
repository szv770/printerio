-- Security review S1 (F3 + F11 quick win). Two independent statements, both safe to apply while the app is live.
--
-- 1. public.check_rate_limit is SECURITY DEFINER and "does no authorization of its own, it only counts" (0012). It
--    stayed executable by every signed-in account (0012 granted it to authenticated), so any member could call it with
--    ANOTHER person's key ("print_submit:<their user id>", ids are visible through the roster) and lock them out of
--    printing, or fill private.rate_limit_buckets with random keys. Only the server needs it, and the server calls it
--    with the service-role client (apps/web: create-print-job.ts, print/preview-action.ts, admin/printers/actions.ts,
--    api/agents/register/route.ts) after its own session / role / agent checks. So take EXECUTE away from everyone
--    except service_role. (anon and PUBLIC were already revoked in 0019; repeated here so this file alone is correct.)
--
--    Order of deploy does not matter: the web code uses the service-role client both before and after this runs.
--    Before it runs the grant is merely broader than needed; after it runs nothing in the app loses access.
--    (Code from BEFORE this change, if it were redeployed afterwards, would fail OPEN: its member-client call would
--    get "permission denied", log "rate limit check failed" and let the request through, i.e. no limiting, no outage.)
--
-- 2. public.adjust_monthly_usage had a role-mutable search_path (Supabase advisor function_search_path_mutable).
--    Re-created with `set search_path = ''` and every object name qualified. The ONLY schema-dependent name in the body
--    is the table monthly_usage (now public.monthly_usage); everything else is a parameter, a column, a plpgsql
--    construct (raise, get diagnostics), the SQL constructs `greatest` / `case`, or a pg_catalog type, all of which
--    resolve with an empty search_path. The row trigger monthly_usage_set_updated_at (private.set_updated_at) only
--    uses new.* and now() (pg_catalog). Otherwise the body is byte-for-byte the one restored by
--    0026_restore_adjust_monthly_usage_null_limit_branch.sql (identical to 0010). Still SECURITY INVOKER.
--    CREATE OR REPLACE keeps the function's existing ACL and owner; the grants are restated below anyway.
--
--    BEFORE APPLYING, compare the live body to 0026 once (it drifted before, see 0026):
--      select pg_get_functiondef('public.adjust_monthly_usage(uuid,uuid,text,int,int,int,int,text,int,text)'::regprocedure);
--    If it differs from 0026, do not apply statement 2 until the difference is understood.

-- 1. check_rate_limit: service_role only.
revoke execute on function public.check_rate_limit(text, int, int) from public, anon, authenticated;
grant execute on function public.check_rate_limit(text, int, int) to service_role;

-- 2. adjust_monthly_usage: fixed search_path.
create or replace function public.adjust_monthly_usage(
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
security invoker
set search_path = ''
as $$
declare
  v_rows int;
begin
  if p_mode not in ('reserve', 'release', 'consume') then
    raise exception 'invalid adjust_monthly_usage mode: %', p_mode;
  end if;

  insert into public.monthly_usage (organization_id, user_id, period)
  values (p_organization_id, p_user_id, p_period)
  on conflict (organization_id, user_id, period) do nothing;

  if p_mode = 'release' then
    update public.monthly_usage set
      reserved_pdf_pages = greatest(0, reserved_pdf_pages - p_pdf_pages),
      reserved_printed_sides = greatest(0, reserved_printed_sides - p_printed_sides),
      reserved_physical_sheets = greatest(0, reserved_physical_sheets - p_physical_sheets),
      reserved_color_weighted = greatest(0, reserved_color_weighted - p_color_weighted)
    where organization_id = p_organization_id and user_id = p_user_id and period = p_period;
    return true;
  end if;

  if p_mode = 'consume' then
    update public.monthly_usage set
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
    update public.monthly_usage set
      reserved_pdf_pages = reserved_pdf_pages + p_pdf_pages,
      reserved_printed_sides = reserved_printed_sides + p_printed_sides,
      reserved_physical_sheets = reserved_physical_sheets + p_physical_sheets,
      reserved_color_weighted = reserved_color_weighted + p_color_weighted
    where organization_id = p_organization_id and user_id = p_user_id and period = p_period;
    return true;
  end if;

  update public.monthly_usage set
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

comment on function public.adjust_monthly_usage is
  'Atomic quota reserve/release/consume - see docs/architecture.md sec 14. '
  'SECURITY INVOKER: runs as the caller, governed by monthly_usage RLS (callable by service_role only since 0034). '
  'Body identical to 0026; 0037 only adds set search_path = '''' and qualifies public.monthly_usage.';

-- Explicit grants (CLAUDE.md / 0031): service_role only, as set in 0034.
revoke execute on function public.adjust_monthly_usage(uuid, uuid, text, int, int, int, int, text, int, text)
  from public, anon, authenticated;
grant execute on function public.adjust_monthly_usage(uuid, uuid, text, int, int, int, int, text, int, text)
  to service_role;
