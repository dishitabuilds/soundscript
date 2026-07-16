-- Conversion history: per-user isolation + audio reuse.
--
-- RLS was already enabled on tts_conversions, but the backend queried with a
-- bare anon key, so auth.uid() was NULL and every insert failed the policy.
-- The backend now forwards the caller's JWT; these policies are restated here
-- so the repo is the source of truth for what they are.

alter table public.tts_conversions enable row level security;

-- Supabase anonymous sign-ins also carry the `authenticated` role, so guests
-- are covered by these policies with no separate code path.

drop policy if exists "Users read own conversions" on public.tts_conversions;
create policy "Users read own conversions"
  on public.tts_conversions for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users insert own conversions" on public.tts_conversions;
create policy "Users insert own conversions"
  on public.tts_conversions for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users delete own conversions" on public.tts_conversions;
create policy "Users delete own conversions"
  on public.tts_conversions for delete
  to authenticated
  using (auth.uid() = user_id);

-- sha256(voice:model:text). Identical input always yields identical audio, so a
-- hit lets us skip the ElevenLabs call entirely.
alter table public.tts_conversions
  add column if not exists content_hash text;

-- Scoped to user_id because the cache lookup runs under the caller's RLS
-- context: a user only ever reuses their own audio. A global cache would save
-- more calls but would leak whether another user had synthesised the same text.
create index if not exists tts_conversions_user_hash_idx
  on public.tts_conversions (user_id, content_hash);

-- Serves both the history listing and the rolling 24h quota sum.
create index if not exists tts_conversions_user_created_idx
  on public.tts_conversions (user_id, created_at desc);

-- Audio objects live at {user_id}/{content_hash}.mp3. The bucket stays public
-- for playback URLs, but writes are restricted to the caller's own folder.
insert into storage.buckets (id, name, public)
values ('tts-bucket', 'tts-bucket', true)
on conflict (id) do nothing;

drop policy if exists "Users upload own audio" on storage.objects;
create policy "Users upload own audio"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'tts-bucket'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Needed because uploads use upsert, which updates on cache-key collision.
drop policy if exists "Users update own audio" on storage.objects;
create policy "Users update own audio"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'tts-bucket'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users delete own audio" on storage.objects;
create policy "Users delete own audio"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'tts-bucket'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
