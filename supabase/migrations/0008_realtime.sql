-- PrintOS: Realtime Authorization for private, per-organization channels.
-- See docs/architecture.md sec 3.4.
--
-- Topic convention: 'org-{organizationId}:{stream}', e.g.
--   org-<uuid>:jobs        (job status changes)
--   org-<uuid>:approvals   (approval queue add/remove)
--   org-<uuid>:agents      (agent online/offline)
--
-- Operational note (not SQL, do at project setup time - see docs/deployment.md):
-- disable "Allow public access" in Supabase Dashboard -> Realtime -> Settings so
-- no unauthenticated/public channel can be joined at all, as defense in depth on
-- top of these policies. Every client-side subscribe call must pass
-- { config: { private: true } } for these policies to be consulted.

create policy "org members can receive broadcast on their org's channels"
on realtime.messages for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and exists (
    select 1 from organization_members m
    where m.user_id = (select auth.uid())
      and m.status = 'active'
      and (select realtime.topic()) like ('org-' || m.organization_id::text || ':%')
  )
);

create policy "org members can send broadcast on their org's channels"
on realtime.messages for insert
to authenticated
with check (
  realtime.messages.extension = 'broadcast'
  and exists (
    select 1 from organization_members m
    where m.user_id = (select auth.uid())
      and m.status = 'active'
      and (select realtime.topic()) like ('org-' || m.organization_id::text || ':%')
  )
);

-- Note: postgres_changes subscriptions (used for a couple of simple list-refresh
-- cases, e.g. print_jobs) need no separate policy here - visibility is governed
-- by RLS on the source table itself (0006_rls_policies.sql), which is consulted
-- per-row by the Realtime server. This gives defense in depth: even a
-- misconfigured broadcast-channel policy could not leak rows a user's own table
-- RLS would not otherwise show them.
