-- Staff jobs should print without approval by default; admins add rules for
-- unusual jobs. Applies to new organizations and to existing ones that still
-- have the old default.
alter table public.organization_settings
  alter column default_policy_action set default 'allow';

update public.organization_settings
  set default_policy_action = 'allow'
  where default_policy_action = 'require_approval';
