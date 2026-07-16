-- Close the wide-open storage policies the bucket was originally created with.
--
-- The bucket shipped with two policies granted to role `public`:
--   "Allow public uploads": INSERT, with_check (bucket_id = 'tts-bucket')
--   "Allow public reads":   SELECT, using      (bucket_id = 'tts-bucket')
--
-- Neither checks the folder, so both allow any caller to touch any user's
-- objects. Postgres ORs permissive policies together, which meant the per-user
-- policies added in 20260716120000 granted nothing extra -- the public ones
-- already allowed everything. Confirmed by test: a second anonymous guest was
-- able to PUT a file into another guest's folder and got HTTP 200.

drop policy if exists "Allow public uploads" on storage.objects;
drop policy if exists "Allow public reads" on storage.objects;

-- Playback does not depend on this policy: the bucket is public, so
-- /storage/v1/object/public/... is served without consulting RLS. This governs
-- the authenticated object API -- notably listing, which must stay per-user so
-- nobody can enumerate another user's audio.
drop policy if exists "Users read own audio" on storage.objects;
create policy "Users read own audio"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'tts-bucket'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Introspection helper from 20260716130000 has served its purpose; leaving it
-- would expose policy definitions to any authenticated user.
drop function if exists public.debug_list_storage_policies();
