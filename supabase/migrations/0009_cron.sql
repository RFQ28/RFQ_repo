-- 0009_cron.sql
-- Drives the job queue from Postgres instead of from the hosting platform.
--
-- The queue only moves when something calls /api/jobs/run. Vercel Cron can do
-- that, but its Hobby plan fires once a day -- and an RFQ that waits 24 hours
-- for a rep to see it is not a product. pg_cron runs every minute on every
-- Supabase plan including the free one, so the scheduler lives next to the
-- queue it drives rather than being a property of where the app happens to be
-- hosted.
--
-- pg_net makes the call asynchronously: http_post returns a request id
-- immediately and the response lands in net._http_response. That matters for a
-- cron job -- a synchronous call that hung would hold a worker slot and the
-- next minute's run would pile up behind it.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Where to call, and with what.
--
-- Both live in Vault rather than being written into the cron command, because
-- cron.job.command is plain text readable by anyone who can query the table.
-- A worker secret sitting there would let any database reader drive the queue.
-- ---------------------------------------------------------------------------

create or replace function app.quote_desk_setting(secret_name text)
returns text
language sql
security definer
set search_path = public, vault, pg_temp
as $$
  select decrypted_secret from vault.decrypted_secrets where name = secret_name limit 1;
$$;

revoke all on function app.quote_desk_setting(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The two calls.
--
-- Failure here must be visible. A cron job that silently stops is the same
-- outcome as having no cron job, and worse than an error, because everything
-- keeps looking healthy while the queue fills up.
-- ---------------------------------------------------------------------------

create or replace function app.call_worker(endpoint text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  base_url text;
  secret   text;
  request_id bigint;
begin
  base_url := app.quote_desk_setting('quote_desk_app_url');
  secret   := app.quote_desk_setting('quote_desk_worker_secret');

  if base_url is null or secret is null then
    raise warning 'quote desk cron: quote_desk_app_url or quote_desk_worker_secret is not in Vault; % not called', endpoint;
    return null;
  end if;

  select net.http_post(
    url := rtrim(base_url, '/') || endpoint,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || secret,
      'Content-Type', 'application/json',
      'x-worker-id', 'pg-cron'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) into request_id;

  return request_id;
end;
$$;

revoke all on function app.call_worker(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The schedule.
--
-- Drain every minute: this interval is the delay between an RFQ arriving and a
-- rep seeing a draft, so it is the one number in this file a distributor would
-- notice.
--
-- Renew every six hours: Graph caps a mail subscription at under three days,
-- and the renewal job's own dedupe key makes queueing it more often than
-- necessary free. Six hours leaves twelve attempts before a subscription could
-- lapse, which is enough to survive a bad afternoon.
-- ---------------------------------------------------------------------------

select cron.unschedule('quote-desk-drain')
where exists (select 1 from cron.job where jobname = 'quote-desk-drain');

select cron.unschedule('quote-desk-renew')
where exists (select 1 from cron.job where jobname = 'quote-desk-renew');

select cron.schedule('quote-desk-drain', '* * * * *', $$select app.call_worker('/api/jobs/run')$$);
select cron.schedule('quote-desk-renew', '0 */6 * * *', $$select app.call_worker('/api/jobs/schedule')$$);
