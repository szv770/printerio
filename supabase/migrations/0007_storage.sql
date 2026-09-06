-- Printio: private storage bucket + path-scoped RLS.
-- Path convention: org/{organizationId}/jobs/{jobId}/original.pdf|derived.pdf
-- See docs/architecture.md sec 3.3. Never a public bucket; downloads always go
-- through createSignedUrl(), never a public URL.

insert into storage.buckets (id, name, public, file_size_limit)
values ('print-jobs', 'print-jobs', false, 104857600) -- 100 MiB hard ceiling; per-org
                                                       -- limits are enforced at the
                                                       -- application layer from
                                                       -- organization_settings.max_upload_size_bytes
on conflict (id) do nothing;

create policy "org members can read their org's job files"
on storage.objects for select
to authenticated
using (
  bucket_id = 'print-jobs'
  and (storage.foldername(name))[1] = 'org'
  and (storage.foldername(name))[2]::uuid in (select private.user_org_ids())
);

create policy "org members can upload their org's job files"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'print-jobs'
  and (storage.foldername(name))[1] = 'org'
  and (storage.foldername(name))[2]::uuid in (select private.user_org_ids())
);

-- Derived files (e.g. booklet padding) are written by server-side application
-- code as the requesting user, so update is allowed under the same scope; the
-- original upload itself is never overwritten by application logic (a new
-- object path is used for derived files) - this policy exists for storage
-- housekeeping only (e.g. re-running a failed derived-file generation).
create policy "org members can update their org's job files"
on storage.objects for update
to authenticated
using (
  bucket_id = 'print-jobs'
  and (storage.foldername(name))[1] = 'org'
  and (storage.foldername(name))[2]::uuid in (select private.user_org_ids())
)
with check (
  bucket_id = 'print-jobs'
  and (storage.foldername(name))[1] = 'org'
  and (storage.foldername(name))[2]::uuid in (select private.user_org_ids())
);

create policy "org_admins can delete their org's job files"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'print-jobs'
  and (storage.foldername(name))[1] = 'org'
  and private.is_org_admin((storage.foldername(name))[2]::uuid)
);

-- Note: the retention-policy cleanup sweep (docs/architecture.md sec 16/§33 of the
-- spec) runs as a service-role Vercel Cron job and therefore does not depend on
-- this delete policy; this policy only covers ad-hoc admin deletes from the
-- dashboard.
