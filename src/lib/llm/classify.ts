import 'server-only'

import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { RfqClassification } from '@/lib/db/types'
import { anthropic, MODEL, runModel } from './client'

/**
 * Is this email an RFQ? (PRD 6.2)
 *
 * The shared inbox is mostly not RFQs: supplier newsletters, order
 * confirmations, delivery questions, invoice queries, spam, replies on old
 * threads. Getting this wrong is costly in both directions — false positives
 * flood reps with junk drafts and destroy trust in week one, false negatives
 * lose deals — so the classifier is deliberately unwilling to be decisive when
 * it is not sure. "possible_rfq" surfaces to the rep rather than dropping.
 */

const ClassificationSchema = z.object({
  decision: z.enum(['new_rfq', 'revision', 'not_rfq', 'possible_rfq']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  signals: z.object({
    has_material_list: z.boolean(),
    asks_for_pricing: z.boolean(),
    names_a_job_or_project: z.boolean(),
    is_automated_or_marketing: z.boolean(),
    references_an_existing_order: z.boolean(),
    looks_like_a_reply_to_our_quote: z.boolean(),
  }),
  job_name: z.string().nullable(),
  due_date: z.string().nullable(),
})

export type ClassificationResult = z.infer<typeof ClassificationSchema>

const SYSTEM = `You triage the shared quotes inbox of an independent electrical supply distributor in the United States.

Contractors email asking for prices on electrical material. Those are RFQs. The same inbox also receives supplier newsletters, order acknowledgements, shipping notifications, invoice questions, delivery scheduling, and spam. Those are not.

Decide between:

- new_rfq: a contractor is asking this distributor to price material. The list may be in the body, in an attachment, or a photo. A request to quote "the attached" with no visible list is still an RFQ.
- revision: the same job, changed. An added or removed item, a changed quantity, a corrected part number, an updated drawing — on a thread or subject we have already quoted.
- not_rfq: anything else. Order status, delivery questions, invoices, statements, marketing, newsletters, automated notifications, or a reply that only says thanks.
- possible_rfq: you genuinely cannot tell. A rep will look at it.

Guidance that matters more than being decisive:

- A quote request from a *supplier to us* is not an RFQ. RFQs come from contractors buying material.
- An email that merely mentions a price is not an RFQ. Asking us to price something is.
- Attachments named like takeoffs, bills of material, schedules, or plans, with a short covering note, are usually RFQs even when the note says little.
- Prefer possible_rfq over guessing. Being unsure is cheap; a junk draft in a rep's inbox is not, and a missed RFQ is a lost deal.

Return confidence as your actual certainty, not a flourish. Reasoning should be one or two sentences a sales manager could read.`

export type ClassifyInput = {
  from: string
  fromName?: string | null
  subject: string | null
  body: string
  attachmentNames: string[]
  /** Set when this thread already has an RFQ against it. */
  threadHasExistingRfq: boolean
  tenantId: string
  emailId?: string
}

const MAX_BODY_CHARS = 12000

function buildPrompt(input: ClassifyInput): string {
  // Long bodies are trimmed from the middle: the opening says what is wanted
  // and the end carries the signature and any trailing list, while the middle
  // of a forwarded chain is where the noise lives.
  let body = input.body.trim()
  if (body.length > MAX_BODY_CHARS) {
    const half = Math.floor(MAX_BODY_CHARS / 2)
    body = `${body.slice(0, half)}\n\n[... ${body.length - MAX_BODY_CHARS} characters omitted ...]\n\n${body.slice(-half)}`
  }

  return [
    `From: ${input.fromName ? `${input.fromName} <${input.from}>` : input.from}`,
    `Subject: ${input.subject ?? '(none)'}`,
    `Attachments: ${input.attachmentNames.length > 0 ? input.attachmentNames.join(', ') : '(none)'}`,
    input.threadHasExistingRfq
      ? 'Thread context: this conversation already has an RFQ on it, so a revision is plausible.'
      : 'Thread context: no RFQ exists on this conversation yet.',
    '',
    'Body:',
    body || '(empty)',
  ].join('\n')
}

/**
 * Signals that settle the question without a model call.
 *
 * Bulk mail headers and no-reply senders are unambiguous, and running the
 * classifier over a newsletter is spending money to be told what the headers
 * already said.
 */
export function obviousNonRfq(input: {
  from: string
  subject: string | null
  headers?: Record<string, string>
}): { decision: RfqClassification; reasoning: string } | null {
  const from = input.from.toLowerCase()
  const subject = (input.subject ?? '').toLowerCase()

  if (input.headers) {
    const keys = Object.keys(input.headers).map((k) => k.toLowerCase())
    if (keys.includes('list-unsubscribe') || keys.includes('precedence')) {
      return { decision: 'not_rfq', reasoning: 'Bulk mail headers (list-unsubscribe / precedence)' }
    }
    if (input.headers['auto-submitted'] && input.headers['auto-submitted'] !== 'no') {
      return { decision: 'not_rfq', reasoning: 'Auto-submitted message' }
    }
  }

  if (/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce)/.test(from.split('@')[0] ?? '')) {
    return { decision: 'not_rfq', reasoning: `Automated sender (${input.from})` }
  }

  if (/^(out of office|automatic reply|undeliverable|delivery status notification)/.test(subject)) {
    return { decision: 'not_rfq', reasoning: 'Auto-reply or bounce' }
  }

  return null
}

export async function classifyEmail(input: ClassifyInput): Promise<ClassificationResult> {
  const prompt = buildPrompt(input)

  return runModel(
    {
      tenantId: input.tenantId,
      purpose: 'classify',
      logRequest: { subject: input.subject, from: input.from, attachments: input.attachmentNames },
    },
    async () => {
      const response = await anthropic().messages.parse({
        model: MODEL,
        max_tokens: 4000,
        // Triage is a judgement call, not a hard reasoning problem, and it runs
        // on every message that arrives. Low effort keeps it quick and cheap.
        output_config: { effort: 'low', format: zodOutputFormat(ClassificationSchema) },
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      })

      const parsed = response.parsed_output
      if (!parsed) {
        // A model that returned nothing usable must not silently become
        // "not an RFQ". Unsure means a rep looks at it.
        return {
          result: {
            decision: 'possible_rfq' as const,
            confidence: 0,
            reasoning: 'The classifier did not return a usable answer, so this is being surfaced for review',
            signals: {
              has_material_list: false, asks_for_pricing: false, names_a_job_or_project: false,
              is_automated_or_marketing: false, references_an_existing_order: false,
              looks_like_a_reply_to_our_quote: false,
            },
            job_name: null,
            due_date: null,
          },
          usage: response.usage,
        }
      }

      // The model is told a revision is plausible only when the thread already
      // carries an RFQ; if it says revision anyway, downgrade rather than
      // linking a draft to a parent that does not exist.
      const decision =
        parsed.decision === 'revision' && !input.threadHasExistingRfq ? 'new_rfq' : parsed.decision

      return { result: { ...parsed, decision }, usage: response.usage }
    },
  )
}
