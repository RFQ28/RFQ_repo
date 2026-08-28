import { createHash } from 'node:crypto'

/**
 * Deduplication and revision detection (PRD 6.1, 6.2).
 *
 * Two failures matter here and they pull in opposite directions:
 *
 *   - Processing the same RFQ twice puts two drafts in front of a rep and makes
 *     the system look broken in week one.
 *   - Treating a genuine second RFQ as a duplicate loses a deal silently, which
 *     is worse, because nobody ever finds out.
 *
 * So the duplicate rules are narrow and literal — the two the PRD names, and no
 * clever generalisation of them — while revision detection, which only ever
 * links a draft to a parent rather than dropping anything, is allowed to be
 * more generous.
 */

export type IncomingEmail = {
  messageId: string
  threadId: string | null
  fromAddress: string
  subject: string | null
  receivedAt: Date
  /** sha256 of each attachment, in any order. */
  attachmentHashes: string[]
}

export type ExistingEmail = {
  id: string
  messageId: string
  threadId: string | null
  fromAddress: string
  subject: string | null
  receivedAt: Date
  attachmentHash: string | null
  rfqId?: string | null
}

/**
 * A stable fingerprint over an email's attachments.
 *
 * Sorted first, so the same two files in a different order are the same
 * attachment set — mail clients do not promise an order. An email with no
 * attachments gets no hash at all rather than the hash of nothing, because
 * otherwise every bodies-only email in the inbox would collide with every
 * other one.
 */
export function attachmentSetHash(hashes: string[]): string | null {
  if (hashes.length === 0) return null
  const digest = createHash('sha256')
  for (const hash of [...hashes].sort()) digest.update(hash)
  return digest.digest('hex')
}

export type DuplicateVerdict =
  | { isDuplicate: false }
  | { isDuplicate: true; of: string; reason: string }

const DEDUP_WINDOW_HOURS = 24

/**
 * The two rules from 6.1: same message id, or same sender and same attachments
 * within 24 hours.
 */
export function findDuplicate(
  incoming: IncomingEmail,
  recent: ExistingEmail[],
): DuplicateVerdict {
  const sameId = recent.find((email) => email.messageId === incoming.messageId)
  if (sameId) {
    return { isDuplicate: true, of: sameId.id, reason: 'Same message id' }
  }

  const hash = attachmentSetHash(incoming.attachmentHashes)
  if (!hash) return { isDuplicate: false }

  const windowStart = incoming.receivedAt.getTime() - DEDUP_WINDOW_HOURS * 3600_000
  const sender = incoming.fromAddress.trim().toLowerCase()

  const sameAttachments = recent.find(
    (email) =>
      email.attachmentHash === hash &&
      email.fromAddress.trim().toLowerCase() === sender &&
      email.receivedAt.getTime() >= windowStart,
  )

  if (sameAttachments) {
    return {
      isDuplicate: true,
      of: sameAttachments.id,
      reason: `Same sender and attachments within ${DEDUP_WINDOW_HOURS}h`,
    }
  }

  return { isDuplicate: false }
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

/** Strips the reply and forward markers mail clients stack up on a subject. */
export function normalizeSubject(subject: string | null): string {
  if (!subject) return ''
  return subject
    .replace(/^(\s*(re|fw|fwd|aw|tr|rv)\s*(\[\d+\])?\s*:\s*)+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Token overlap between two subjects, ignoring reply markers. */
export function subjectSimilarity(a: string | null, b: string | null): number {
  const left = new Set(normalizeSubject(a).split(' ').filter((word) => word.length > 2))
  const right = new Set(normalizeSubject(b).split(' ').filter((word) => word.length > 2))
  if (left.size === 0 || right.size === 0) return 0

  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / Math.min(left.size, right.size)
}

export type RevisionCandidate = {
  rfqId: string
  emailId: string
  threadId: string | null
  fromAddress: string
  subject: string | null
  receivedAt: Date
}

export type RevisionVerdict =
  | { isRevision: false }
  | { isRevision: true; parentRfqId: string; confidence: number; reason: string }

const SUBJECT_MATCH_THRESHOLD = 0.7
const SUBJECT_WINDOW_DAYS = 30

/**
 * Whether this email revises an RFQ we already have.
 *
 * Thread id first, exactly as 6.2 asks: it is what the mail system itself says
 * about the conversation, and it is either right or absent. Only when there is
 * no thread match does subject similarity get a say, and then only from the
 * same sender and inside a month — a contractor who sends "Riverside Medical"
 * twice in March and again in November means two different jobs.
 */
export function findRevisionParent(
  incoming: IncomingEmail,
  candidates: RevisionCandidate[],
): RevisionVerdict {
  if (incoming.threadId) {
    const sameThread = candidates.find((candidate) => candidate.threadId === incoming.threadId)
    if (sameThread) {
      return {
        isRevision: true,
        parentRfqId: sameThread.rfqId,
        confidence: 0.95,
        reason: 'Same email thread as an RFQ we already have',
      }
    }
  }

  const sender = incoming.fromAddress.trim().toLowerCase()
  const windowStart = incoming.receivedAt.getTime() - SUBJECT_WINDOW_DAYS * 86400_000

  let best: { candidate: RevisionCandidate; score: number } | null = null

  for (const candidate of candidates) {
    if (candidate.fromAddress.trim().toLowerCase() !== sender) continue
    if (candidate.receivedAt.getTime() < windowStart) continue

    const score = subjectSimilarity(incoming.subject, candidate.subject)
    if (score >= SUBJECT_MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { candidate, score }
    }
  }

  if (best) {
    return {
      isRevision: true,
      parentRfqId: best.candidate.rfqId,
      // Lower than a thread match, because a subject is a guess about intent
      // and a thread id is a fact about the conversation.
      confidence: Math.min(0.85, 0.6 + best.score * 0.25),
      reason: `Same sender and a matching subject ("${normalizeSubject(best.candidate.subject)}")`,
    }
  }

  return { isRevision: false }
}

// ---------------------------------------------------------------------------
// Which contractor sent it (6.5)
// ---------------------------------------------------------------------------

export type CustomerIdentifier = {
  customerId: string
  kind: 'email_domain' | 'email_address'
  value: string
  confirmedByRep: boolean
}

export type CustomerVerdict = {
  customerId: string | null
  confidence: number
  reason: string
  /** True when several customers matched and a rep should be asked once. */
  ambiguous: boolean
}

/**
 * Identifies the contractor from the sending address.
 *
 * A specific address beats a domain, and an identifier a rep confirmed beats
 * one that came out of an import — that is the "ask the rep once and remember"
 * in 6.5. Where two customers claim the same domain, nothing is chosen: a quote
 * priced against the wrong contractor's discounts is worse than a quote that
 * pauses to ask.
 */
export function identifyCustomer(
  fromAddress: string,
  identifiers: CustomerIdentifier[],
): CustomerVerdict {
  const address = fromAddress.trim().toLowerCase()
  const domain = address.split('@')[1] ?? ''

  const addressMatches = identifiers.filter(
    (identifier) => identifier.kind === 'email_address' && identifier.value.toLowerCase() === address,
  )
  const domainMatches = identifiers.filter(
    (identifier) => identifier.kind === 'email_domain' && identifier.value.toLowerCase() === domain,
  )

  for (const [matches, kind, confidence] of [
    [addressMatches, 'address', 0.99],
    [domainMatches, 'domain', 0.9],
  ] as const) {
    if (matches.length === 0) continue

    const confirmed = matches.filter((match) => match.confirmedByRep)
    const chosen = confirmed.length > 0 ? confirmed : matches
    const distinct = new Set(chosen.map((match) => match.customerId))

    if (distinct.size === 1) {
      return {
        customerId: chosen[0].customerId,
        confidence: confirmed.length > 0 ? 0.99 : confidence,
        reason:
          confirmed.length > 0
            ? `A rep confirmed this ${kind} belongs to this customer`
            : `Matched on the sender's ${kind}`,
        ambiguous: false,
      }
    }

    return {
      customerId: null,
      confidence: 0,
      reason: `${distinct.size} customers share this ${kind} — a rep needs to say which`,
      ambiguous: true,
    }
  }

  return {
    customerId: null,
    confidence: 0,
    reason: `No customer is registered against ${address}`,
    ambiguous: false,
  }
}
