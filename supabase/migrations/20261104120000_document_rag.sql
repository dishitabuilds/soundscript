-- Separate source evidence from speech chunks; deleting a document removes both.
create extension if not exists vector with schema extensions;
create table public.document_passages (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  paragraph_idx integer not null check (paragraph_idx >= 0),
  part_idx integer not null check (part_idx >= 0),
  audio_chunk_idx integer,
  text text not null check (length(text) between 1 and 900),
  embedding extensions.vector(384),
  embedding_model text,
  fts tsvector generated always as (to_tsvector('english', text)) stored,
  unique (document_id, paragraph_idx, part_idx),
  check ((embedding is null) = (embedding_model is null))
);
create index document_passages_document on public.document_passages(document_id);
create index document_passages_fts on public.document_passages using gin(fts);
alter table public.document_passages enable row level security;
grant select, insert, update, delete on public.document_passages to authenticated;
create policy "owners access source passages" on public.document_passages
  for all to authenticated
  using (user_id = (select auth.uid()) and exists (
    select 1 from public.documents d where d.id = document_id and d.user_id = (select auth.uid())
  ))
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.documents d where d.id = document_id and d.user_id = (select auth.uid())
  ));

-- Exact cosine search is deliberate for small per-document collections. Add an
-- ANN index only after benchmarking filtered recall. RRF k is shared with eval.
create function public.search_document_passages(
  p_document_id uuid, p_query text, p_embedding extensions.vector(384) default null,
  p_model text default null, p_mode text default 'hybrid', p_limit integer default 20
) returns table(id uuid, text text, paragraph_idx integer, audio_chunk_idx integer, score double precision)
language sql stable security invoker set search_path = public, extensions
as $$
  with candidates as materialized (
    select * from public.document_passages
    where document_id = p_document_id and user_id = (select auth.uid())
  ), lexical as (
    select id, row_number() over(order by ts_rank_cd(fts, websearch_to_tsquery('english', p_query)) desc, id) r
    from candidates where p_mode in ('keyword','hybrid')
      and fts @@ websearch_to_tsquery('english', p_query)
    order by r limit 40
  ), semantic as (
    select id, row_number() over(order by embedding <=> p_embedding, id) r
    from candidates where p_mode in ('semantic','hybrid') and p_embedding is not null
      and embedding_model = p_model and embedding is not null
    order by r limit 40
  )
  select c.id, c.text, c.paragraph_idx, c.audio_chunk_idx,
    (coalesce(1.0 / (60 + l.r), 0) + coalesce(1.0 / (60 + s.r), 0))::double precision score
  from candidates c left join lexical l using(id) left join semantic s using(id)
  where l.id is not null or s.id is not null
  order by score desc, c.id limit greatest(1, least(p_limit, 40));
$$;
revoke all on function public.search_document_passages(uuid,text,extensions.vector,text,text,integer) from public, anon;
grant execute on function public.search_document_passages(uuid,text,extensions.vector,text,text,integer) to authenticated;
