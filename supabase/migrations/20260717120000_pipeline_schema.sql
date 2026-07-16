-- Document -> narrated audio pipeline.
--
-- Shape of the work: a document is uploaded, its text is split into chunks small
-- enough for the TTS API, each chunk is synthesised independently, and the
-- results are stitched back together in order.
--
-- Key modelling decisions, and why:
--
-- 1. Chunks hang off the document, not the job. Chunking is deterministic from
--    the text, so the chunks are a property of the document. A job is one
--    *attempt* to synthesise them. Re-running after a failure creates a new job
--    but reuses the existing chunks, so only the failed ones are redone.
--
-- 2. Every table carries user_id, even where it is reachable by joining through
--    document_id. RLS policies run on every row touched, and a policy that has
--    to join is both slower and easier to get wrong. Denormalising keeps every
--    policy the same one-line shape.
--
-- 3. Status lives per chunk, not just per job. That is what makes progress
--    reporting ("47 of 112") and resume-after-failure possible at all.
--
-- 4. audio_cache owns synthesised audio; chunks only point at it. Deleting a
--    document must not delete audio another document still needs, and content
--    that has been paid for once should never be paid for twice.

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  source_type text not null check (source_type in ('pdf', 'txt', 'paste')),
  -- Where the original upload sits in storage. Null for pasted text, which has
  -- no source file.
  source_path text,
  char_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists documents_user_created_idx
  on public.documents (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- audio_cache
-- ---------------------------------------------------------------------------

-- Content-addressed store of synthesised audio: sha256(voice:model:text).
-- Per-user rather than global, matching the decision in 20260716120000 -- a
-- shared cache would leak whether another user had synthesised the same text.
-- The bucket is stored alongside the path so the single-shot converter (public
-- tts-bucket) can be folded in later without a schema change.
create table if not exists public.audio_cache (
  user_id uuid not null references auth.users (id) on delete cascade,
  content_hash text not null,
  bucket text not null default 'library',
  path text not null,
  char_count integer not null,
  created_at timestamptz not null default now(),
  primary key (user_id, content_hash)
);

-- ---------------------------------------------------------------------------
-- chunks
-- ---------------------------------------------------------------------------

create table if not exists public.chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Position in the document. Stitching reassembles strictly by this.
  idx integer not null,
  text text not null,
  char_count integer not null,
  content_hash text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'done', 'failed')),
  -- Retry bookkeeping. attempts guards against a poison chunk being retried
  -- forever; last_error is kept so a failure can be explained rather than just
  -- counted.
  attempts integer not null default 0,
  last_error text,
  -- Set on completion. Points into audio_cache for this user + hash.
  path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Two chunks cannot claim the same slot in a document.
  unique (document_id, idx)
);

-- The worker's hot path: find the next pending chunk for a document, in order.
create index if not exists chunks_document_status_idx
  on public.chunks (document_id, status, idx);

-- Cache probe: has this user already synthesised identical text?
create index if not exists chunks_user_hash_idx
  on public.chunks (user_id, content_hash);

-- ---------------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------------

-- One row per attempt at a document. Kept as history rather than mutated in
-- place, so a retry does not erase the record of why the last run failed.
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists jobs_document_created_idx
  on public.jobs (document_id, created_at desc);

create index if not exists jobs_user_status_idx
  on public.jobs (user_id, status);

-- ---------------------------------------------------------------------------
-- audio_assets
-- ---------------------------------------------------------------------------

-- The finished, stitched audiobook for a document.
create table if not exists public.audio_assets (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  bucket text not null default 'library',
  path text not null,
  duration_seconds numeric,
  byte_size bigint,
  -- [{ "title": "Chapter 1", "start_seconds": 0 }, ...]
  chapters jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audio_assets_document_idx
  on public.audio_assets (document_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists chunks_touch_updated_at on public.chunks;
create trigger chunks_touch_updated_at
  before update on public.chunks
  for each row
  execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.documents enable row level security;
alter table public.audio_cache enable row level security;
alter table public.chunks enable row level security;
alter table public.jobs enable row level security;
alter table public.audio_assets enable row level security;

-- Anonymous (guest) users carry the `authenticated` role too, so these cover
-- guests and account holders through one code path.
do $$
declare
  t text;
begin
  foreach t in array array['documents', 'audio_cache', 'chunks', 'jobs', 'audio_assets']
  loop
    execute format('drop policy if exists "own rows select" on public.%I', t);
    execute format(
      'create policy "own rows select" on public.%I for select to authenticated using (auth.uid() = user_id)', t);

    execute format('drop policy if exists "own rows insert" on public.%I', t);
    execute format(
      'create policy "own rows insert" on public.%I for insert to authenticated with check (auth.uid() = user_id)', t);

    execute format('drop policy if exists "own rows update" on public.%I', t);
    execute format(
      'create policy "own rows update" on public.%I for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);

    execute format('drop policy if exists "own rows delete" on public.%I', t);
    execute format(
      'create policy "own rows delete" on public.%I for delete to authenticated using (auth.uid() = user_id)', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Work claiming
-- ---------------------------------------------------------------------------

-- Hands the caller exactly one pending chunk and marks it processing, in a
-- single atomic statement.
--
-- FOR UPDATE SKIP LOCKED is what makes concurrent workers safe: the row is
-- locked as it is selected, and any worker racing for the same row skips past
-- it to the next candidate instead of blocking or double-claiming. Without it,
-- two workers both read the same 'pending' row and synthesise it twice --
-- paying twice and racing on the write.
--
-- SECURITY INVOKER (the default) is deliberate: the function runs as the
-- caller, so the RLS policies above still apply and a worker cannot claim
-- another user's chunk even by passing their document id.
create or replace function public.claim_next_chunk(p_document_id uuid)
returns setof public.chunks
language sql
as $$
  update public.chunks c
  set status = 'processing',
      attempts = c.attempts + 1
  where c.id = (
    select id
    from public.chunks
    where document_id = p_document_id
      and status = 'pending'
    order by idx
    limit 1
    for update skip locked
  )
  returning c.*;
$$;

grant execute on function public.claim_next_chunk(uuid) to authenticated;

-- Progress for a document, as one round trip. Derived by counting rather than
-- kept as a counter on jobs, because a counter and the rows it summarises drift
-- apart the first time anything fails midway.
create or replace function public.document_progress(p_document_id uuid)
returns table (
  total bigint,
  done bigint,
  failed bigint,
  pending bigint,
  processing bigint
)
language sql
stable
as $$
  select
    count(*) as total,
    count(*) filter (where status = 'done') as done,
    count(*) filter (where status = 'failed') as failed,
    count(*) filter (where status = 'pending') as pending,
    count(*) filter (where status = 'processing') as processing
  from public.chunks
  where document_id = p_document_id;
$$;

grant execute on function public.document_progress(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------

-- Private, unlike tts-bucket. A user's uploaded notes and the narration of them
-- are their own; playback uses short-lived signed URLs rather than a public URL
-- that anyone holding the link can replay forever.
insert into storage.buckets (id, name, public)
values ('library', 'library', false)
on conflict (id) do nothing;

drop policy if exists "library own objects select" on storage.objects;
create policy "library own objects select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'library'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "library own objects insert" on storage.objects;
create policy "library own objects insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'library'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "library own objects update" on storage.objects;
create policy "library own objects update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'library'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "library own objects delete" on storage.objects;
create policy "library own objects delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'library'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
