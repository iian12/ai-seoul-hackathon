-- Apply once using the Supabase SQL editor or `supabase db push`.
-- Immutable, atomic snapshots: a failed collection/import never removes the last good row.
create table public.housing_snapshots (
  id text primary key,
  created_at timestamptz not null default now(),
  published boolean not null default false,
  payload jsonb not null,
  constraint housing_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint housing_snapshot_id_matches check (payload->>'id' = id),
  constraint housing_model_version check (payload->>'modelVersion' in ('mvp-1.0', 'seoul-observed-1.0')),
  constraint housing_areas_array check (jsonb_typeof(payload->'areas') = 'array'),
  constraint housing_sources_array check (jsonb_typeof(payload->'sources') = 'array'),
  constraint housing_demo_boolean check (jsonb_typeof(payload->'isDemo') = 'boolean')
);
create index housing_snapshots_latest_published on public.housing_snapshots(created_at desc) where published;
alter table public.housing_snapshots enable row level security;
revoke all on public.housing_snapshots from anon, authenticated;
grant select on public.housing_snapshots to anon, authenticated;
grant all on public.housing_snapshots to service_role;
create policy "Read published housing snapshots only"
on public.housing_snapshots for select to anon, authenticated using (published = true);

create table public.housing_ingestion_runs (
  id bigint generated always as identity primary key,
  snapshot_id text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running', 'success', 'failed')),
  area_count integer,
  -- Generic codes only. Never store request URLs, credentials or raw upstream errors.
  error_code text
);
alter table public.housing_ingestion_runs enable row level security;
revoke all on public.housing_ingestion_runs from anon, authenticated;
grant all on public.housing_ingestion_runs to service_role;
grant usage, select on sequence public.housing_ingestion_runs_id_seq to service_role;
comment on table public.housing_snapshots is '서울 한정 검증 스냅샷. anonymous read-only published rows, server-only inserts. Never store secrets here.';
