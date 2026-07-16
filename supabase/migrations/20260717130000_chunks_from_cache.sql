-- Distinguish chunks that were served from cache from chunks that cost an API
-- call.
--
-- The daily quota exists to cap spend at ElevenLabs, so it must count what was
-- actually sent there. A chunk satisfied from audio_cache spends nothing, and
-- charging it against the cap would mean re-uploading an unchanged document --
-- the case that should be free and instant -- could be refused for quota.
--
-- This cannot be inferred after the fact: a cache hit and a completed synthesis
-- both end up status='done' with a path. It has to be recorded when it happens.

alter table public.chunks
  add column if not exists from_cache boolean not null default false;

-- Supports the quota sum: billable chunks for a user inside a time window.
create index if not exists chunks_user_billable_idx
  on public.chunks (user_id, created_at desc)
  where from_cache = false;
