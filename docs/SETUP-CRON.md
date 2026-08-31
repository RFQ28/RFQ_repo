# Driving the queue

The queue only moves when something calls `/api/jobs/run`. Enqueueing always
succeeds — the webhook accepts a notification and writes a job whether or not
anything ever drains it — so a missing scheduler does not announce itself. The
inbox simply appears to stop working while every screen still reads healthy.

Two ways to do it. **Supabase `pg_cron` is the recommended one**: it runs every
minute on every plan including the free tier, and it does not change if you
move the app off Vercel.

---

## Option A — Supabase pg_cron (recommended)

### 1. Apply the migration

Run `supabase/migrations/0009_cron.sql` in the SQL editor. It enables `pg_cron`
and `pg_net`, creates the two helper functions, and schedules both jobs.

### 2. Tell it where to call, and with what

The migration deliberately contains no URL and no secret. `cron.job.command` is
plain text and readable by anyone who can query the table, so a worker secret
written there would let any database reader drive the queue. Both values go in
Vault instead:

```sql
select vault.create_secret(
  'https://your-app.vercel.app',
  'quote_desk_app_url',
  'Base URL the cron jobs call. No trailing slash.'
);

select vault.create_secret(
  '<the same value as WORKER_SECRET in the deployment>',
  'quote_desk_worker_secret',
  'Bearer token for /api/jobs/*'
);
```

To change either later, update rather than re-create:

```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'quote_desk_app_url'),
  'https://the-new-domain.com'
);
```

**The URL has to be publicly reachable.** These calls come from Supabase's
servers, not from your machine, so `localhost` will not work — the same
constraint the Graph webhook has. For local testing point it at a tunnel; for
the pilot point it at the deployment.

### 3. Check it is actually running

```sql
-- Both jobs present and active?
select jobname, schedule, active from cron.job order by jobname;

-- Did the last runs succeed? (status 'succeeded' means the SQL ran, which is
-- not the same as the HTTP call succeeding -- see the next query for that.)
select j.jobname, r.status, r.start_time, r.return_message
from cron.job_run_details r
join cron.job j on j.jobid = r.jobid
order by r.start_time desc
limit 10;

-- What did the app actually answer? pg_net keeps responses for a few hours.
select status_code, content, created
from net._http_response
order by created desc
limit 10;
```

A healthy drain returns `200` with a body like
`{"claimed":0,"succeeded":0,"failed":0,"dead":0}`. Claimed zero is normal —
most minutes there is nothing to do.

| What you see | Cause |
|---|---|
| `cron.job` empty | The migration did not run, or ran against a different project. |
| `job_run_details` shows `failed` | Read `return_message`. Usually the warning from a missing Vault secret. |
| No rows in `net._http_response` | The function returned before calling out — a missing Vault secret. Check `select name from vault.secrets`. |
| `401` in the response | `quote_desk_worker_secret` does not match `WORKER_SECRET` on the deployment. |
| `404` | `quote_desk_app_url` is wrong, or has a trailing slash and a path was appended to it. |
| Timeouts | The deployment is asleep or the URL is not publicly reachable. |

### Turning it off

```sql
select cron.unschedule('quote-desk-drain');
select cron.unschedule('quote-desk-renew');
```

---

## Option B — Vercel Cron

Already declared in `vercel.json`, and it needs no database work. Set
`CRON_SECRET` on the deployment to the same value as `WORKER_SECRET`; Vercel
sends it as `Authorization: Bearer $CRON_SECRET` and the endpoints check it
against `WORKER_SECRET`.

**Vercel's Hobby plan runs cron jobs once per day.** At that cadence an RFQ can
sit for 24 hours before a rep sees it, and the renewal sweep is too infrequent
to rely on. On Hobby, use Option A.

If you use Option A, you can delete the `crons` array from `vercel.json`.
Leaving it is harmless — overlapping drains are safe, because `claim_jobs`
locks rows with `SKIP LOCKED` — but two schedulers for one queue is a thing to
explain later.

---

## What each job does

| Job | Schedule | Why |
|---|---|---|
| `quote-desk-drain` -> `/api/jobs/run` | every minute | The interval between an RFQ arriving and a rep seeing a draft. The one number here a distributor would notice. |
| `quote-desk-renew` -> `/api/jobs/schedule` | every 6 hours | Queues the Graph subscription renewal. Graph caps a mail subscription at under three days; without this the mailbox goes quiet on day three and nothing reports it. |
