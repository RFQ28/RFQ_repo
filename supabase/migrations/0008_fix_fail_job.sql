-- 0008_fix_fail_job.sql
--
-- Fixes a defect that made the whole "never lose an RFQ" guarantee (PRD s8, s9)
-- untrue in practice.
--
-- `fail_job` set status from a CASE expression, which Postgres types as `text`.
-- Assigning text to a `job_status` column raises 42804, so the UPDATE never ran:
-- a job that failed stayed 'running' with no error recorded, and `claim_jobs`
-- only ever claims 'queued', so it was never retried, never dead-lettered and
-- never alerted on. It simply stopped, silently, which is the one outcome the
-- queue exists to prevent.
--
-- Two changes:
--   1. Cast the status expression to job_status.
--   2. Reclaim jobs stranded in 'running' by a worker that died mid-job. On a
--      serverless runtime a timeout or a redeploy can end a worker between
--      claiming a job and finishing it, and without this those jobs are stuck
--      exactly the same way.

create or replace function public.fail_job(job_id uuid, message text)
returns public.jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  j public.jobs;
  give_up boolean;
begin
  select * into j from public.jobs where id = job_id for update;
  if not found then
    raise exception 'job % not found', job_id;
  end if;

  give_up := j.attempts >= j.max_attempts;

  update public.jobs
     set status = (case when give_up then 'dead' else 'queued' end)::public.job_status,
         -- 2^attempts minutes, capped at an hour
         run_after = now() + least(interval '1 hour', (power(2, j.attempts) * interval '1 minute')),
         last_error = message,
         error_history = j.error_history || jsonb_build_object('at', now(), 'attempt', j.attempts, 'error', message),
         finished_at = case when give_up then now() else null end,
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
-- claim_jobs, now also reclaiming stranded work
-- ---------------------------------------------------------------------------

create or replace function public.claim_jobs(
  worker_id text,
  batch_size int default 1,
  stale_after interval default interval '15 minutes'
)
returns setof public.jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A job still 'running' long after it was claimed belongs to a worker that is
  -- not coming back. It is returned to the queue and counts as an attempt, so a
  -- job that reliably kills its worker still reaches the dead-letter state
  -- instead of cycling forever.
  update public.jobs
     set status = 'queued',
         locked_by = null,
         locked_at = null,
         last_error = coalesce(last_error, 'Worker stopped without finishing this job'),
         run_after = now()
   where status = 'running'
     and locked_at is not null
     and locked_at < now() - stale_after;

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

revoke all on function public.claim_jobs(text, int, interval) from public, anon, authenticated;
grant execute on function public.claim_jobs(text, int, interval) to service_role;

-- The two-argument version is replaced by the one above; dropping it keeps a
-- stale signature from being resolved by mistake.
drop function if exists public.claim_jobs(text, int);
