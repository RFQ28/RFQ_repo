import 'server-only'

import type { JobKind, JobHandler } from './queue'
import { parseRfq } from './handlers/parse-rfq'
import { matchRfq } from './handlers/match-rfq'

/**
 * The handler registry.
 *
 * A job kind with no handler here is dead-lettered on sight rather than
 * retried, so this table and the JobKind union have to stay in step.
 */
export const handlers: Partial<Record<JobKind, JobHandler>> = {
  parse_rfq: parseRfq,
  match_rfq: matchRfq,
}

export { enqueue, runJobs, deadLetters, retryJob } from './queue'
export type { JobKind, JobHandler, WorkerResult } from './queue'
