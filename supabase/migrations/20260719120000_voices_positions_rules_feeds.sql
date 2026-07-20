-- Feature batch: per-document voices, read-along timelines, resumable
-- playback, pronunciation rules, and private podcast feeds.
--
-- Everything here follows the conventions set in 20260717120000: user_id on
-- every table even where joinable, one-line RLS policies, counting over
-- counters.

-- ---------------------------------------------------------------------------
-- documents: voice choice and new source formats
-- ---------------------------------------------------------------------------

-- Which voice narrates this document. Null means "the server default", so
-- existing rows and callers that never pick a voice keep working unchanged.
-- Stored per document rather than per user because a listener may want a
-- different narrator for a novel than for lecture notes.
alter table public.documents add column if not exists provider text;
alter table public.documents add column if not exists voice_id text;
alter table public.documents add column if not exists model_id text;

-- EPUB and DOCX join the allowed sources. The constraint is dropped and
-- recreated because CHECK constraints cannot be altered in place.
alter table public.documents drop constraint if exists documents_source_type_check;
alter table public.documents add constraint documents_source_type_check
  check (source_type in ('pdf', 'epub', 'docx', 'txt', 'paste'));

-- ---------------------------------------------------------------------------
-- audio_assets: per-chunk timeline for read-along
-- ---------------------------------------------------------------------------

-- [{ "idx": 0, "startSeconds": 0, "endSeconds": 4.2, "paragraphIdx": 0 }, ...]
-- Chunk text is deliberately NOT duplicated here -- it already lives on the
-- chunks table, and the read-along view joins the two by idx.
alter table public.audio_assets add column if not exists timeline jsonb;

-- ---------------------------------------------------------------------------
-- listening_positions: resume where you left off
-- ---------------------------------------------------------------------------

-- One row per user per document, upserted as playback progresses. Keyed on the
-- pair rather than an id so the upsert has a natural conflict target.
create table if not exists public.listening_positions (
  user_id uuid not null references auth.users (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  position_seconds numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, document_id)
);

-- ---------------------------------------------------------------------------
-- pronunciation_rules: per-user text substitutions
-- ---------------------------------------------------------------------------

-- Applied to document text before chunking, so the fix is in the audio and in
-- the cache key -- corrected text hashes differently from uncorrected text,
-- which is exactly right.
create table if not exists public.pronunciation_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Literal text to find, not a regex: users type "TTS", not "\bTTS\b", and a
  -- malformed user regex must never be able to take the pipeline down.
  pattern text not null check (char_length(pattern) between 1 and 100),
  replacement text not null check (char_length(replacement) <= 200),
  created_at timestamptz not null default now(),
  unique (user_id, pattern)
);

create index if not exists pronunciation_rules_user_idx
  on public.pronunciation_rules (user_id);

-- ---------------------------------------------------------------------------
-- user_feeds: private podcast feed tokens
-- ---------------------------------------------------------------------------

-- The token is a bearer secret in a URL, because podcast apps cannot send an
-- Authorization header. Rotating it is the revocation story, so it is stored
-- replaceable rather than derived from the user id.
create table if not exists public.user_feeds (
  user_id uuid primary key references auth.users (id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.listening_positions enable row level security;
alter table public.pronunciation_rules enable row level security;
alter table public.user_feeds enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['listening_positions', 'pronunciation_rules', 'user_feeds']
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

-- The public feed endpoint resolves token -> user with the service-role key,
-- which bypasses RLS by design. No anon policy is added here on purpose: the
-- token must never be readable through the API surface.
