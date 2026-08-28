-- 0004_ingestion_jobs.sql
-- Catalogue/price ingestion with validation, preview and diff-before-commit
-- (s8), plus the durable job queue that intake, parsing and matching run on
-- (s8: never lose an RFQ to a failed job).

-- ---------------------------------------------------------------------------
-- catalogue_imports
--
-- An upload moves through: uploaded -> validating -> previewed (diff computed,
-- awaiting a human) -> committing -> committed. It can be discarded at any
-- point before commit, and every staged row is kept so the diff is auditable.
-- ---------------------------------------------------------------------------

create type public.import_kind as enum ('products', 'price_rules', 'customers', 'substitutions');

create type public.import_status as enum (
  'uploaded', 'validating', 'previewed', 'committing', 'committed', 'failed', 'discarded'
);

create table if not exists public.catalogue_imports (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,

  kind            public.import_kind not null,
  status          public.import_status not null default 'uploaded',

  filename        text not null,
  storage_path    text not null,
  content_type    text,
  size_bytes      bigint,
  sha256          text,

  -- how the uploaded file's columns map onto our fields, remembered per tenant
  -- so the next monthly export does not need re-mapping
  column_mapping  jsonb,

  row_count       int,
  valid_count     int,
  error_count     int,
  warning_count   int,

  -- diff against the currently committed catalogue, computed at preview time
  diff_summary    jsonb,   -- { created, updated, unchanged, deactivated, price_changes }

  -- set when this import replaces rows not present in the file
  deactivate_missing boolean not null default false,

  is_scheduled    boolean not null default false,
  uploaded_by     uuid references public.users(id) on delete set null,
  committed_by    uuid references public.users(id) on delete set null,
  committed_at    timestamptz,
  error           text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists catalogue_imports_tenant_idx
  on public.catalogue_imports (tenant_id, created_at desc);

create trigger catalogue_imports_touch before update on public.catalogue_imports
  for each row execute function app.touch_updated_at();

-- Staged rows. Held until commit so the rep-facing preview shows exactly what
-- will change, and so a bad export can be discarded without touching live data.
create table if not exists public.catalogue_import_rows (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  import_id     uuid not null references public.catalogue_imports(id) on delete cascade,

  row_number    int not null,
  raw           jsonb not null,        -- the source row, verbatim
  normalized    jsonb,                 -- after mapping + coercion

  is_valid      boolean not null default true,
  errors        text[] not null default '{}',
  warnings      text[] not null default '{}',

  -- what committing this row would do
  diff_action   text check (diff_action in ('create', 'update', 'unchanged', 'skip')),
  diff_fields   jsonb,                 -- { field: { from, to } }
  target_id     uuid,                  -- existing row this would update

  created_at    timestamptz not null default now(),

  unique (import_id, row_number)
);

create index if not exists catalogue_import_rows_import_idx
  on public.catalogue_import_rows (import_id, row_number);
create index if not exists catalogue_import_rows_invalid_idx
  on public.catalogue_import_rows (import_id) where not is_valid;
create index if not exists catalogue_import_rows_tenant_idx
  on public.catalogue_import_rows (tenant_id);

-- ---------------------------------------------------------------------------
-- jobs
--
-- Durable queue with retries, exponential backoff and a dead-letter state.
-- Claimed with FOR UPDATE SKIP LOCKED so several workers can run at once.
-- ---------------------------------------------------------------------------

create type public.job_status as enum ('queued', 'running', 'succeeded', 'failed', 'dead');

create table if not exists public.jobs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid references public.tenants(id) on delete cascade,

  kind           text not null,     -- ingest_email | parse_rfq | match_rfq | embed_products | ...
  payload        jsonb not null default '{}'::jsonb,

  -- work for the same key never runs concurrently (e.g. one RFQ at a time)
  dedupe_key     text,

  status         public.job_status not null default 'queued',
  priority       int not null default 100,
  attempts       int not null default 0,
  max_attempts   int not null default 5,

  run_after      timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  locked_by      text,
  locked_at      timestamptz,

  last_error     text,
  error_history  jsonb not null default '[]'::jsonb,

  rfq_id         uuid references public.rfqs(id) on delete cascade,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists jobs_claim_idx
  on public.jobs (status, run_after, priority) where status = 'queued';
create index if not exists jobs_tenant_idx on public.jobs (tenant_id, created_at desc);
create index if not exists jobs_dead_idx on public.jobs (status) where status = 'dead';
create unique index if not exists jobs_dedupe_idx
  on public.jobs (dedupe_key) where dedupe_key is not null and status in ('queued', 'running');

create trigger jobs_touch before update on public.jobs
  for each row execute function app.touch_updated_at();

-- Claim up to `batch_size` due jobs for one worker.
--
-- Lives in `public` because PostgREST only exposes functions from the schemas
-- it is configured with, and the worker calls this over rpc(). Execute is
-- revoked from everyone except service_role, so being visible is not being
-- callable -- a browser session gets a permission error, not a job.
create or replace function public.claim_jobs(worker_id text, batch_size int default 1)
returns setof public.jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.jobs j
     set status = 'running',
         attempts = j.attempts + 1,
         started_at = now(),
         locked_by = worker_id,
         locked_at = now()
   where j.id in (
     select id from public.jobs
      where status = 'queued' and run_after <= now()
      order by priority asc, run_after asc
      for update skip locked
      limit batch_size
   )
  returning j.*;
end;
$$;

revoke all on function public.claim_jobs(text, int) from public, anon, authenticated;
grant execute on function public.claim_jobs(text, int) to service_role;

-- Record a failure and either reschedule with backoff or dead-letter the job.
create or replace function public.fail_job(job_id uuid, message text)
returns public.jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  j public.jobs;
begin
  select * into j from public.jobs where id = job_id for update;
  if not found then
    raise exception 'job % not found', job_id;
  end if;

  update public.jobs
     set status = case when j.attempts >= j.max_attempts then 'dead' else 'queued' end,
         -- 2^attempts minutes, capped at an hour
         run_after = now() + least(interval '1 hour', (power(2, j.attempts) * interval '1 minute')),
         last_error = message,
         error_history = j.error_history || jsonb_build_object('at', now(), 'attempt', j.attempts, 'error', message),
         finished_at = case when j.attempts >= j.max_attempts then now() else null end,
         locked_by = null,
         locked_at = null
   where id = job_id
  returning * into j;

  return j;
end;
$$;

revoke all on function public.fail_job(uuid, text) from public, anon, authenticated;
grant execute on function public.fail_job(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- notifications (6.12) -- outbound, deduplicated, with a delivery record
-- ---------------------------------------------------------------------------

create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  kind          text not null,   -- draft_ready | stale_rfq | weekly_summary | import_failed | mailbox_error
  channel       text not null check (channel in ('email_thread', 'email', 'teams')),
  recipient     text,
  user_id       uuid references public.users(id) on delete set null,

  rfq_id        uuid references public.rfqs(id) on delete cascade,
  quote_id      uuid references public.quotes(id) on delete cascade,

  subject       text,
  body          text,
  payload       jsonb,

  status        text not null default 'pending'
                check (status in ('pending', 'sent', 'failed', 'suppressed')),
  sent_at       timestamptz,
  error         text,

  -- one alert per thing per window; the owner is interrupted once, not hourly
  dedupe_key    text,

  created_at    timestamptz not null default now()
);

create unique index if not exists notifications_dedupe_idx
  on public.notifications (tenant_id, dedupe_key) where dedupe_key is not null;
create index if not exists notifications_tenant_idx on public.notifications (tenant_id, created_at desc);
create index if not exists notifications_pending_idx on public.notifications (status) where status = 'pending';
