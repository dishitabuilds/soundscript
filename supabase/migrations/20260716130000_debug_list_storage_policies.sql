-- TEMPORARY introspection helper. Dropped again in the next migration.
-- Exists only to reveal which pre-existing policies guard storage.objects,
-- since pg_policies is not reachable through PostgREST and `db dump` needs
-- a local Docker daemon.

create or replace function public.debug_list_storage_policies()
returns table (
  policyname text,
  permissive text,
  roles text,
  cmd text,
  qual text,
  with_check text
)
language sql
security definer
set search_path = pg_catalog, public
as $$
  select
    p.policyname::text,
    p.permissive::text,
    p.roles::text,
    p.cmd::text,
    p.qual::text,
    p.with_check::text
  from pg_policies p
  where p.schemaname = 'storage'
    and p.tablename = 'objects'
  order by p.policyname;
$$;

grant execute on function public.debug_list_storage_policies() to authenticated;
