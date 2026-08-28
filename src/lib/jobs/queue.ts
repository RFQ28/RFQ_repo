import 'server-only'

import { adminClient } from '@/lib/supabase/admin'
import type { JobRow, Json } from '@/lib/db/types'

/**
 * The durable queue (PRD s8).
 *
 * Email intake, parsing and matching are not run in the request path — a single
 * RFQ can take minutes. The requirement above every other here is that **no RFQ
 * is ever lost to a failed job**: a failure reschedules with backoff, and a job
 * that exhausts its attempts is dead-lettered and alerted on, never dropped.
 */

export type JobKind =
  | 'ingest_email'
  | 'parse_rfq'
  | 'match_rfq'
  | 'embed_products'
  | 'renew_graph_subscription'
  | 'send_notification'
  | 'stale_rfq_sweep'
  | 'weekly_summary'

export type EnqueueOptions = {
  tenantId?: string | null
  payload?: Record<string, unknown>
  /** Work for the same key never runs twice concurrently. */
  dedupeKey?: string
  priority?: number
  runAfter?: Date
  maxAttempts?: number
  rfqId?: string | null
}

export async function enqueue(kind: JobKind, options: EnqueueOptions = {}): Promise<string | null> {
  const { data, error } = await adminClient()
    .from('jobs')
    .insert({
      kind,
      tenant_id: options.tenantId ?? null,
      payload: (options.payload ?? {}) as Json,
      dedupe_key: options.dedupeKey ?? null,
      priority: options.priority ?? 100,
      run_after: (options.runAfter ?? new Date()).toISOString(),
      max_attempts: options.maxAttempts ?? 5,
      rfq_id: options.rfqId ?? null,
    })
    .select('id')
    .single()

  if (error) {
    // A duplicate dedupe key means the work is already queued or running, which
    // is the whole point of the key — not a failure.
    if (error.code === '23505') return null
    throw new Error(`enqueue(${kind}) failed: ${error.message}`)
  }

  return data?.id ?? null
}

export type JobHandler = (job: JobRow) => Promise<void>

export type WorkerResult = {
  claimed: number
  succeeded: number
  failed: number
  dead: number
}

/**
 * Claims and runs a batch of due jobs.
 *
 * Driven by an external scheduler hitting /api/jobs/run rather than by a
 * long-lived process, because the deployment target is serverless. Several
 * invocations can overlap safely — `claim_jobs` locks with SKIP LOCKED.
 */
export async function runJobs(
  handlers: Partial<Record<JobKind, JobHandler>>,
  options: { workerId: string; batchSize?: number } = { workerId: 'worker' },
): Promise<WorkerResult> {
  const db = adminClient()
  const result: WorkerResult = { claimed: 0, succeeded: 0, failed: 0, dead: 0 }

  const { data: claimed, error } = await db.rpc('claim_jobs' as never, {
    worker_id: options.workerId,
    batch_size: options.batchSize ?? 5,
  } as never)

  if (error) throw new Error(`claim_jobs failed: ${error.message}`)

  const jobs = (claimed ?? []) as unknown as JobRow[]
  result.claimed = jobs.length

  for (const job of jobs) {
    const handler = handlers[job.kind as JobKind]

    if (!handler) {
      // An unknown kind is a deployment problem, not a transient one, so it is
      // dead-lettered immediately rather than retried five times.
      await db
        .from('jobs')
        .update({
          status: 'dead',
          finished_at: new Date().toISOString(),
          last_error: `No handler registered for job kind "${job.kind}"`,
        })
        .eq('id', job.id)
      result.dead += 1
      continue
    }

    try {
      await handler(job)
      await db
        .from('jobs')
        .update({ status: 'succeeded', finished_at: new Date().toISOString(), locked_by: null })
        .eq('id', job.id)
      result.succeeded += 1
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown)
      const { data: failed, error: failError } = await db.rpc('fail_job' as never, {
        job_id: job.id,
        message,
      } as never)

      if (failError) {
        // The function whose whole purpose is to make sure a failure is
        // recorded has itself failed. Ignoring this is how a job sits in
        // 'running' forever — never retried, never dead-lettered, never
        // reported — which is exactly the silent loss the queue exists to
        // prevent. Put the job back by hand and say so loudly.
        console.error('fail_job failed; releasing the job by hand', {
          jobId: job.id,
          kind: job.kind,
          originalError: message,
          failError,
        })

        await db
          .from('jobs')
          .update({
            status: job.attempts >= job.max_attempts ? 'dead' : 'queued',
            run_after: new Date(Date.now() + 60_000).toISOString(),
            last_error: `${message} (and fail_job errored: ${failError.message})`,
            locked_by: null,
            locked_at: null,
          })
          .eq('id', job.id)

        result.failed += 1
        continue
      }

      const status = (failed as unknown as JobRow | null)?.status
      if (status === 'dead') {
        result.dead += 1
        await alertDeadJob(job, message)
      } else {
        result.failed += 1
      }
    }
  }

  return result
}

/**
 * A dead job means something did not get quoted. That is exactly the case the
 * PRD says must alert rather than disappear (s9).
 */
async function alertDeadJob(job: JobRow, message: string) {
  if (!job.tenant_id) {
    console.error('dead job on a platform-level task', { kind: job.kind, id: job.id, message })
    return
  }

  await adminClient()
    .from('notifications')
    .insert({
      tenant_id: job.tenant_id,
      kind: 'job_failed',
      channel: 'email',
      rfq_id: job.rfq_id,
      subject: `A ${job.kind.replace(/_/g, ' ')} job could not be completed`,
      body: message,
      payload: { job_id: job.id, kind: job.kind, attempts: job.attempts } as Json,
      dedupe_key: `job_failed:${job.id}`,
    })
}

/** Jobs that gave up, for the admin screen. */
export async function deadLetters(limit = 50): Promise<JobRow[]> {
  const { data } = await adminClient()
    .from('jobs')
    .select('*')
    .eq('status', 'dead')
    .order('finished_at', { ascending: false })
    .limit(limit)
  return (data ?? []) as unknown as JobRow[]
}

/** Puts a dead job back on the queue, attempts reset. Admin action. */
export async function retryJob(jobId: string): Promise<void> {
  const { error } = await adminClient()
    .from('jobs')
    .update({
      status: 'queued',
      attempts: 0,
      run_after: new Date().toISOString(),
      finished_at: null,
      last_error: null,
    })
    .eq('id', jobId)
    .eq('status', 'dead')

  if (error) throw new Error(`retryJob failed: ${error.message}`)
}
