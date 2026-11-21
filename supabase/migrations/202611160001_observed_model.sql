-- For databases which already applied the original MVP migration.
alter table public.housing_snapshots drop constraint if exists housing_model_version;
alter table public.housing_snapshots add constraint housing_model_version
check (payload->>'modelVersion' in ('mvp-1.0', 'seoul-observed-1.0'));
