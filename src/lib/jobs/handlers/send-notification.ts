import 'server-only'

import type { JobRow } from '@/lib/db/types'
import { tenantDb } from '@/lib/supabase/tenant'

/**
 * Records a notification for delivery (PRD 6.12, s9).
 *
 * There is no email provider wired yet, so this does not send anything. What
 * it does is make the intent durable: a row in `notifications` with status
 * `pending`, which the sender drains when it exists, and which an owner can
 * already read on screen.
 *
 * That distinction matters more than it looks. Without a handler registered
 * for this kind, `runJobs` dead-letters the job on sight — and because
 * `alertDeadJob` files a `job_failed` notification for every dead job, every
 * successfully drafted RFQ produced a "a send notification job could not be
 * completed" alert. The queue's one real promise is that a dead job means
 * something did not get quoted; drowning it in false positives for work that
 * succeeded is how that promise stops being believed.
 *
 * Delivery is deliberately not attempted here. A handler that swallowed the
 * work and returned success would look identical to a working notification
 * system while sending nothing, which is the failure this codebase keeps
 * choosing to avoid.
 */

type NotificationPayload = {
  kind?: string
  rfqId?: string | null
  quoteId?: string | null
  /** Overrides for kinds that carry their own wording. */
  subject?: string
  body?: string
  recipient?: string
  userId?: string | null
  channel?: 'email' | 'email_thread' | 'teams'
}

/** What each kind says, when the caller does not say it itself. */
const WORDING: Record<string, { subject: string; body: string }> = {
  draft_ready: {
    subject: 'A draft quote is ready to review',
    body: 'An RFQ has been matched and priced. Open it to review the flagged lines and send.',
  },
  stale_rfq: {
    subject: 'An RFQ has been waiting',
    body: 'This RFQ has been sitting unquoted past the threshold set for your tenant.',
  },
  weekly_summary: {
    subject: 'Your weekly quoting summary',
    body: 'Quotes drafted, sent, won and lost over the last seven days.',
  },
}

export async function sendNotification(job: JobRow): Promise<void> {
  if (!job.tenant_id) throw new Error('send_notification job has no tenant')

  const payload = (job.payload ?? {}) as NotificationPayload
  const kind = payload.kind
  if (!kind) throw new Error('send_notification job has no kind')

  const db = tenantDb(job.tenant_id)
  const wording = WORDING[kind]

  const { error } = await db.from('notifications').insert({
    kind,
    channel: payload.channel ?? 'email',
    recipient: payload.recipient ?? null,
    user_id: payload.userId ?? null,
    rfq_id: payload.rfqId ?? job.rfq_id ?? null,
    quote_id: payload.quoteId ?? null,
    subject: payload.subject ?? wording?.subject ?? `Quote Desk: ${kind.replace(/_/g, ' ')}`,
    body: payload.body ?? wording?.body ?? null,
    payload: payload as never,
    status: 'pending',
    // One per thing, not one per retry. The job's own dedupe key already
    // stops the work being queued twice; this stops a re-queued job after a
    // dedupe window has passed from filing a second copy.
    dedupe_key: `${kind}:${payload.quoteId ?? payload.rfqId ?? job.id}`,
  })

  // A duplicate is the dedupe index doing its job, not a failure.
  if (error && error.code !== '23505') {
    throw new Error(`Could not record the ${kind} notification: ${error.message}`)
  }
}
