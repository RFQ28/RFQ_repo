import { describe, expect, it } from 'vitest'
import {
  attachmentSetHash, findDuplicate, findRevisionParent, identifyCustomer,
  normalizeSubject, subjectSimilarity,
  type ExistingEmail, type IncomingEmail, type RevisionCandidate,
} from '@/lib/intake/dedup'
import { encryptToken, decryptToken, secretsMatch } from '@/lib/crypto/tokens'

const NOW = new Date('2026-03-10T15:00:00Z')

function incoming(over: Partial<IncomingEmail> = {}): IncomingEmail {
  return {
    messageId: '<msg-1@contractor.com>',
    threadId: 'thread-1',
    fromAddress: 'mike@riverside-electric.com',
    subject: 'Quote request - Riverside Medical Phase 2',
    receivedAt: NOW,
    attachmentHashes: [],
    ...over,
  }
}

function existing(over: Partial<ExistingEmail> = {}): ExistingEmail {
  return {
    id: 'e1',
    messageId: '<other@contractor.com>',
    threadId: 'thread-other',
    fromAddress: 'mike@riverside-electric.com',
    subject: 'Something else',
    receivedAt: new Date(NOW.getTime() - 3600_000),
    attachmentHash: null,
    ...over,
  }
}

describe('attachmentSetHash', () => {
  it('does not depend on attachment order', () => {
    expect(attachmentSetHash(['a', 'b'])).toBe(attachmentSetHash(['b', 'a']))
  })

  it('gives no hash at all when there are no attachments', () => {
    // Otherwise every body-only email in the inbox would collide.
    expect(attachmentSetHash([])).toBeNull()
  })

  it('distinguishes different attachment sets', () => {
    expect(attachmentSetHash(['a', 'b'])).not.toBe(attachmentSetHash(['a', 'c']))
  })
})

describe('findDuplicate', () => {
  it('catches the same message id', () => {
    const verdict = findDuplicate(incoming(), [existing({ id: 'dup', messageId: '<msg-1@contractor.com>' })])
    expect(verdict).toMatchObject({ isDuplicate: true, of: 'dup', reason: 'Same message id' })
  })

  it('catches the same sender and attachments inside the window', () => {
    const hash = attachmentSetHash(['sha-a', 'sha-b'])!
    const verdict = findDuplicate(
      incoming({ attachmentHashes: ['sha-b', 'sha-a'] }),
      [existing({ id: 'dup', attachmentHash: hash, receivedAt: new Date(NOW.getTime() - 3600_000) })],
    )
    expect(verdict).toMatchObject({ isDuplicate: true, of: 'dup' })
  })

  it('lets the same attachments through after the window', () => {
    const hash = attachmentSetHash(['sha-a'])!
    const verdict = findDuplicate(
      incoming({ attachmentHashes: ['sha-a'] }),
      [existing({ attachmentHash: hash, receivedAt: new Date(NOW.getTime() - 25 * 3600_000) })],
    )
    expect(verdict.isDuplicate).toBe(false)
  })

  it('lets the same attachments through from a different sender', () => {
    const hash = attachmentSetHash(['sha-a'])!
    const verdict = findDuplicate(
      incoming({ attachmentHashes: ['sha-a'] }),
      [existing({ attachmentHash: hash, fromAddress: 'someone@else.com' })],
    )
    expect(verdict.isDuplicate).toBe(false)
  })

  it('does not call two body-only emails duplicates', () => {
    const verdict = findDuplicate(
      incoming({ attachmentHashes: [] }),
      [existing({ attachmentHash: null })],
    )
    expect(verdict.isDuplicate).toBe(false)
  })
})

describe('normalizeSubject', () => {
  it('strips stacked reply and forward markers', () => {
    expect(normalizeSubject('RE: FW: Re: Riverside Medical')).toBe('riverside medical')
    expect(normalizeSubject('RE[2]: Riverside Medical')).toBe('riverside medical')
  })

  it('handles an absent subject', () => {
    expect(normalizeSubject(null)).toBe('')
  })
})

describe('subjectSimilarity', () => {
  it('is high for the same subject with reply markers', () => {
    expect(subjectSimilarity('Riverside Medical Phase 2', 'RE: Riverside Medical Phase 2')).toBe(1)
  })

  it('is low for different jobs', () => {
    expect(subjectSimilarity('Riverside Medical', 'Oakwood Apartments')).toBeLessThan(0.3)
  })
})

describe('findRevisionParent', () => {
  const candidate: RevisionCandidate = {
    rfqId: 'rfq-1',
    emailId: 'e1',
    threadId: 'thread-1',
    fromAddress: 'mike@riverside-electric.com',
    subject: 'Quote request - Riverside Medical Phase 2',
    receivedAt: new Date(NOW.getTime() - 86400_000),
  }

  it('links on the thread id first', () => {
    const verdict = findRevisionParent(incoming(), [candidate])
    expect(verdict).toMatchObject({ isRevision: true, parentRfqId: 'rfq-1' })
    if (verdict.isRevision) expect(verdict.confidence).toBeGreaterThan(0.9)
  })

  it('falls back to sender and subject when there is no thread', () => {
    const verdict = findRevisionParent(
      incoming({ threadId: null, subject: 'RE: Quote request - Riverside Medical Phase 2' }),
      [{ ...candidate, threadId: null }],
    )
    expect(verdict).toMatchObject({ isRevision: true, parentRfqId: 'rfq-1' })
    if (verdict.isRevision) expect(verdict.confidence).toBeLessThan(0.9)
  })

  it('will not link a matching subject from a different sender', () => {
    const verdict = findRevisionParent(
      incoming({ threadId: null, fromAddress: 'someone@else.com' }),
      [{ ...candidate, threadId: null }],
    )
    expect(verdict.isRevision).toBe(false)
  })

  it('will not link the same job name months apart', () => {
    const verdict = findRevisionParent(
      incoming({ threadId: null }),
      [{ ...candidate, threadId: null, receivedAt: new Date(NOW.getTime() - 200 * 86400_000) }],
    )
    expect(verdict.isRevision).toBe(false)
  })

  it('says no when there is nothing to link to', () => {
    expect(findRevisionParent(incoming(), []).isRevision).toBe(false)
  })
})

describe('identifyCustomer', () => {
  const identifiers = [
    { customerId: 'c1', kind: 'email_domain' as const, value: 'riverside-electric.com', confirmedByRep: false },
    { customerId: 'c2', kind: 'email_address' as const, value: 'bob@gmail.com', confirmedByRep: true },
  ]

  it('matches on the sender domain', () => {
    const verdict = identifyCustomer('mike@riverside-electric.com', identifiers)
    expect(verdict.customerId).toBe('c1')
    expect(verdict.ambiguous).toBe(false)
  })

  it('prefers a specific address over a domain', () => {
    const verdict = identifyCustomer('bob@gmail.com', identifiers)
    expect(verdict.customerId).toBe('c2')
    expect(verdict.confidence).toBeGreaterThan(0.95)
  })

  it('prefers what a rep confirmed over what an import guessed', () => {
    const verdict = identifyCustomer('mike@shared.com', [
      { customerId: 'imported', kind: 'email_domain', value: 'shared.com', confirmedByRep: false },
      { customerId: 'confirmed', kind: 'email_domain', value: 'shared.com', confirmedByRep: true },
    ])
    expect(verdict.customerId).toBe('confirmed')
    expect(verdict.reason).toMatch(/rep confirmed/)
  })

  it('refuses to choose when two customers share a domain', () => {
    const verdict = identifyCustomer('mike@shared.com', [
      { customerId: 'c1', kind: 'email_domain', value: 'shared.com', confirmedByRep: false },
      { customerId: 'c2', kind: 'email_domain', value: 'shared.com', confirmedByRep: false },
    ])
    expect(verdict.customerId).toBeNull()
    expect(verdict.ambiguous).toBe(true)
  })

  it('says plainly when nobody matches', () => {
    const verdict = identifyCustomer('stranger@nowhere.com', identifiers)
    expect(verdict.customerId).toBeNull()
    expect(verdict.ambiguous).toBe(false)
    expect(verdict.reason).toMatch(/No customer is registered/)
  })
})

describe('token encryption', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64')

  it('round-trips a token', () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY
    const token = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.refresh-token-value'
    expect(decryptToken(encryptToken(token))).toBe(token)
  })

  it('produces different ciphertext each time', () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY
    expect(encryptToken('same')).not.toBe(encryptToken('same'))
  })

  it('refuses a tampered ciphertext instead of returning something wrong', () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY
    const encoded = encryptToken('secret')
    const [version, iv, tag, ciphertext] = encoded.split('.')
    const flipped = Buffer.from(ciphertext, 'base64url')
    flipped[0] ^= 0xff
    expect(() => decryptToken([version, iv, tag, flipped.toString('base64url')].join('.'))).toThrow()
  })

  it('refuses a token that is not in our format', () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY
    expect(() => decryptToken('not-a-token')).toThrow(/recognised format/)
  })
})

describe('secretsMatch', () => {
  it('matches identical secrets', () => {
    expect(secretsMatch('abc123', 'abc123')).toBe(true)
  })

  it('rejects different secrets, including different lengths', () => {
    expect(secretsMatch('abc123', 'abc124')).toBe(false)
    expect(secretsMatch('abc', 'abc123')).toBe(false)
  })
})
