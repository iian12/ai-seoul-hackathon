-- Full collected records are private, unfiltered JSONB rows. Aggregated public snapshots stay separate.
create table public.housing_raw_collections (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  manifest jsonb not null,
  archive_verified boolean not null default false,
  state text not null default 'loading' check (state in ('loading', 'complete')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (manifest->>'id' = id)
);
create table public.housing_raw_sources (
  id bigint generated always as identity primary key,
  collection_id text not null references public.housing_raw_collections(id),
  source_id text not null,
  expected_rows bigint not null check (expected_rows >= 0),
  loaded_rows bigint not null default 0 check (loaded_rows >= 0 and loaded_rows <= expected_rows),
  records_sha256 text not null check (records_sha256 ~ '^[a-f0-9]{64}$'),
  state text not null default 'loading' check (state in ('loading', 'complete')),
  unique (collection_id, source_id)
);
create table public.housing_raw_records (
  source_id bigint not null references public.housing_raw_sources(id),
  row_no bigint not null check (row_no > 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (source_id, row_no)
);
create table public.housing_raw_batches (
  source_id bigint not null references public.housing_raw_sources(id),
  start_row bigint not null check (start_row > 0),
  row_count integer not null check (row_count between 1 and 1000),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  primary key (source_id, start_row)
);
alter table public.housing_raw_collections enable row level security;
alter table public.housing_raw_sources enable row level security;
alter table public.housing_raw_records enable row level security;
alter table public.housing_raw_batches enable row level security;
revoke all on public.housing_raw_collections, public.housing_raw_sources, public.housing_raw_records, public.housing_raw_batches from public, anon, authenticated;
grant all on public.housing_raw_collections, public.housing_raw_sources, public.housing_raw_records, public.housing_raw_batches to service_role;
grant usage, select on sequence public.housing_raw_sources_id_seq to service_role;

-- A batch is atomic and safe to retry after a dropped response. Different content cannot overwrite it.
create function public.housing_import_raw_batch(p_source_id bigint, p_start_row bigint, p_rows_json text, p_sha256 text)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare s public.housing_raw_sources%rowtype; b public.housing_raw_batches%rowtype; n integer; p_rows jsonb;
begin
  select * into strict s from public.housing_raw_sources where id = p_source_id for update;
  p_rows := p_rows_json::jsonb;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'invalid_batch'; end if;
  n := jsonb_array_length(p_rows);
  if n < 1 or n > 1000 or exists (select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r) <> 'object') then raise exception 'invalid_batch'; end if;
  if p_sha256 is distinct from pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_rows_json, 'UTF8')), 'hex') then raise exception 'batch_hash_mismatch'; end if;
  select * into b from public.housing_raw_batches where source_id = p_source_id and start_row = p_start_row;
  if found then
    if b.sha256 <> p_sha256 or b.row_count <> n then raise exception 'batch_content_conflict'; end if;
    return s.loaded_rows;
  end if;
  if s.state <> 'loading' or p_start_row <> s.loaded_rows + 1 or s.loaded_rows + n > s.expected_rows then raise exception 'batch_sequence_or_count_mismatch'; end if;
  insert into public.housing_raw_records(source_id, row_no, payload)
    select p_source_id, p_start_row + ordinality - 1, value from jsonb_array_elements(p_rows) with ordinality;
  insert into public.housing_raw_batches values (p_source_id, p_start_row, n, p_sha256);
  update public.housing_raw_sources set loaded_rows = loaded_rows + n where id = p_source_id;
  return s.loaded_rows + n;
end $$;

create function public.housing_finish_raw_source(p_source_id bigint)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare s public.housing_raw_sources%rowtype; actual bigint;
begin
  select * into strict s from public.housing_raw_sources where id = p_source_id for update;
  select count(*) into actual from public.housing_raw_records where source_id = p_source_id;
  if s.loaded_rows <> s.expected_rows or actual <> s.expected_rows then raise exception 'source_incomplete'; end if;
  update public.housing_raw_sources set state = 'complete' where id = p_source_id;
  return actual;
end $$;

create function public.housing_finish_raw_collection(p_collection_id text)
returns void language plpgsql security invoker set search_path = '' as $$
declare c public.housing_raw_collections%rowtype; expected integer;
begin
  select * into strict c from public.housing_raw_collections where id = p_collection_id for update;
  expected := jsonb_array_length(c.manifest->'sources');
  if not c.archive_verified or expected < 1 or
    (select count(*) from public.housing_raw_sources where collection_id = p_collection_id and state = 'complete') <> expected or
    exists (select 1 from public.housing_raw_sources where collection_id = p_collection_id and state <> 'complete')
    then raise exception 'collection_incomplete'; end if;
  update public.housing_raw_collections set state = 'complete', completed_at = now() where id = p_collection_id;
end $$;
revoke all on function public.housing_import_raw_batch(bigint, bigint, text, text), public.housing_finish_raw_source(bigint), public.housing_finish_raw_collection(text) from public, anon, authenticated;
grant execute on function public.housing_import_raw_batch(bigint, bigint, text, text), public.housing_finish_raw_source(bigint), public.housing_finish_raw_collection(text) to service_role;

-- Private archive; service key only. No anonymous/authenticated Storage policy is added.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('housing-raw', 'housing-raw', false, 47185920, array['application/octet-stream', 'application/json'])
on conflict (id) do nothing;
