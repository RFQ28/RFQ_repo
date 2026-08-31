import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { serverEnv } from '@/lib/env'
import { enqueue } from '@/lib/jobs'

export const dynamic = 'force-dynamic'

/**
 * Puts the recurring work on the queue. The companion to /api/jobs/run, which
 * only drains what is already there.
 *
 * Graph caps a mail subscription at under three days, and the only thing that
 * ever enqueued a renewal was the OAuth callback — once, at connect time.
 * After that nothing re-queued it, so a deployment would watch a mailbox for
 * three days and then stop. Silently: the subscription lapses, no webhook
 * arrives, no job fails, and every screen still says "connected" while the
 * distributor's RFQs pile up unquoted. That is the exact failure the renewal
 * handler was written to prevent, defeated by having no scheduler.
 *
 * The renewal handler is a sweep over every connection, so one job covers all
 * tenants. Its dedupe key means calling this more often than necessary is
 * free: a renewal already queued or running is not queued twice.
 */
export async function GET(request: NextRequest) {
  return schedule(request)
}

export async function POST(request: NextRequest) {
  return schedule(request)
}

async function schedule(request: NextRequest) {
  const { WORKER_SECRET } = serverEnv()
  if (!WORKER_SECRET) {
    return NextResponse.json({ error: 'Worker is not configured' }, { status: 503 })
  }

  const presented = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (!secretsMatch(presented, WORKER_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const jobId = await enqueue('renew_graph_subscription', {
      dedupeKey: 'renew_graph_subscription',
      priority: 50,
    })

    // A null id means one was already queued or running — the dedupe key doing
    // its job, not a failure.
    return NextResponse.json({
      queued: jobId ? ['renew_graph_subscription'] : [],
      alreadyPending: jobId ? [] : ['renew_graph_subscription'],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('scheduler failed', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
