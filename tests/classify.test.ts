import { describe, expect, it } from 'vitest'
import { obviousNonRfq } from '@/lib/llm/classify'
import { costOf } from '@/lib/llm/client'

/**
 * The classifier itself needs a model to test properly, and that belongs in an
 * eval against the design partner's real inbox rather than in unit tests. What
 * is tested here is everything around it: the cheap decisions that skip the
 * model, and the cost accounting the pricing of the product depends on.
 */

describe('obviousNonRfq', () => {
  it('drops bulk mail on its headers', () => {
    const result = obviousNonRfq({
      from: 'news@supplier.com',
      subject: 'March product update',
      headers: { 'List-Unsubscribe': '<mailto:x@y.com>' },
    })
    expect(result?.decision).toBe('not_rfq')
  })

  it('drops auto-submitted mail', () => {
    expect(
      obviousNonRfq({ from: 'a@b.com', subject: 'Ticket #4', headers: { 'auto-submitted': 'auto-generated' } })?.decision,
    ).toBe('not_rfq')
  })

  it('keeps a message whose auto-submitted header says no', () => {
    expect(
      obviousNonRfq({ from: 'mike@contractor.com', subject: 'Quote request', headers: { 'auto-submitted': 'no' } }),
    ).toBeNull()
  })

  it('drops no-reply senders', () => {
    expect(obviousNonRfq({ from: 'no-reply@ups.com', subject: 'Shipment' })?.decision).toBe('not_rfq')
    expect(obviousNonRfq({ from: 'donotreply@bank.com', subject: 'Statement' })?.decision).toBe('not_rfq')
    expect(obviousNonRfq({ from: 'MAILER-DAEMON@mail.com', subject: 'Failure' })?.decision).toBe('not_rfq')
  })

  it('drops out-of-office replies and bounces', () => {
    expect(obviousNonRfq({ from: 'mike@contractor.com', subject: 'Out of Office: RFQ' })?.decision).toBe('not_rfq')
    expect(obviousNonRfq({ from: 'x@y.com', subject: 'Undeliverable: quote' })?.decision).toBe('not_rfq')
  })

  it('sends a real contractor email to the model rather than deciding here', () => {
    expect(obviousNonRfq({ from: 'mike@riversideelectric.com', subject: 'Quote request - Riverside' })).toBeNull()
  })

  it('does not drop a sender whose name merely contains "reply"', () => {
    expect(obviousNonRfq({ from: 'replyto.mike@contractor.com', subject: 'RFQ' })).toBeNull()
  })
})

describe('costOf', () => {
  it('prices a call at the published rates', () => {
    // 1M input at $5 plus 1M output at $25
    expect(costOf({ input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(30, 6)
  })

  it('bills a cache read at a tenth of the input rate', () => {
    const uncached = costOf({ input_tokens: 100_000, output_tokens: 0 })
    const cached = costOf({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 100_000 })
    expect(cached).toBeCloseTo(uncached / 10, 8)
  })

  it('bills a cache write at a premium', () => {
    const uncached = costOf({ input_tokens: 100_000, output_tokens: 0 })
    const written = costOf({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 100_000 })
    expect(written).toBeCloseTo(uncached * 1.25, 8)
  })

  it('is zero when there is no usage to price', () => {
    expect(costOf(undefined)).toBe(0)
  })
})
