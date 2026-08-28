import 'server-only'

import Anthropic from '@anthropic-ai/sdk'
import { serverEnv } from '@/lib/env'
import { adminClient } from '@/lib/supabase/admin'

/**
 * The one place this application talks to a model.
 *
 * Everything goes through `runModel`, which logs input, output, model and cost
 * per tenant (PRD s8, s9). LLM spend has to stay visible per distributor or the
 * pricing of the product stops making sense, and a match nobody can explain is
 * a match a rep will not trust.
 */

export const MODEL = 'claude-opus-5'

/** Published rates for `claude-opus-5`, in dollars per million tokens. */
const RATES = { input: 5, output: 25 } as const

let cached: Anthropic | null = null

export function anthropic(): Anthropic {
  if (cached) return cached
  const { ANTHROPIC_API_KEY } = serverEnv()
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — see .env.example')
  }
  cached = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  return cached
}

export type LlmPurpose = 'classify' | 'parse' | 'match' | 'summarize'

export type UsageLike = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export function costOf(usage: UsageLike | undefined): number {
  if (!usage) return 0
  // Cached reads are billed at roughly a tenth of the input rate; treating them
  // as full price would overstate spend on the classifier, which re-sends the
  // same instructions every time.
  const cachedRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const fresh = usage.input_tokens ?? 0

  const input = (fresh * RATES.input + cachedRead * RATES.input * 0.1 + cacheWrite * RATES.input * 1.25) / 1_000_000
  const output = ((usage.output_tokens ?? 0) * RATES.output) / 1_000_000
  return Math.round((input + output) * 1_000_000) / 1_000_000
}

export type RunContext = {
  tenantId: string | null
  purpose: LlmPurpose
  rfqId?: string | null
  /** Kept out of the log when the content is a customer's document. */
  logRequest?: unknown
  logResponse?: unknown
}

/**
 * Wraps one model call with timing, cost accounting and a durable record.
 *
 * A failed call is logged too — a classifier that started erroring at 3pm is
 * something an admin needs to be able to see afterwards, not guess at.
 */
export async function runModel<T>(
  context: RunContext,
  call: () => Promise<{ result: T; usage: UsageLike | undefined }>,
): Promise<T> {
  const startedAt = Date.now()

  try {
    const { result, usage } = await call()
    await record(context, usage, Date.now() - startedAt, null)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await record(context, undefined, Date.now() - startedAt, message)
    throw error
  }
}

async function record(
  context: RunContext,
  usage: UsageLike | undefined,
  latencyMs: number,
  error: string | null,
) {
  try {
    await adminClient()
      .from('llm_calls')
      .insert({
        tenant_id: context.tenantId,
        purpose: context.purpose,
        model: MODEL,
        input_tokens: usage?.input_tokens ?? null,
        output_tokens: usage?.output_tokens ?? null,
        cost_usd: usage ? costOf(usage) : null,
        latency_ms: latencyMs,
        request: (context.logRequest ?? null) as never,
        response: (context.logResponse ?? null) as never,
        error,
        rfq_id: context.rfqId ?? null,
      })
  } catch (loggingError) {
    // Losing the cost record must not lose the work it was recording.
    console.error('llm_calls insert failed', loggingError)
  }
}
