import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { serverEnv } from '@/lib/env'
import { handlers, runJobs } from '@/lib/jobs'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Drains a batch of due jobs. Driven by an external scheduler (Vercel Cron or
 * anything that can make an authenticated request on an interval), because the
 * deployment target has no long-lived process to hold a worker loop.
 *
 * Overlapping invocations are safe: `claim_jobs` locks rows with SKIP LOCKED.
 */
export async function POST(request: NextRequest) {
  const { WORKER_SECRET } = serverEnv()
  if (!WORKER_SECRET) {
    return NextResponse.json({ error: 'Worker is not configured' }, { status: 503 })
  }

  const presented = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (!secretsMatch(presented, WORKER_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workerId = request.headers.get('x-worker-id') ?? `worker-${crypto.randomUUID().slice(0, 8)}`

  try {
    const result = await runJobs(handlers, { workerId, batchSize: 5 })
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('job runner failed', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** Constant-time, and length-safe: comparing buffers of different sizes throws. */
function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
