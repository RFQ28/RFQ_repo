import type { ConfidenceBand, MatchAlternative } from '@/lib/db/types'
import {
  issueLabels, lineGroup, linePriority, lineSeverity,
  type GroupKey, type Priority, type Severity,
} from '@/lib/quote/triage'

export type SourceLine = {
  id: string
  lineNumber: number
  rawText: string
  isParsed: boolean
  parseError: string | null
  sourceDocument: string | null
}

export type ReviewLine = {
  id: string
  lineNumber: number
  rfqLineId: string | null
  productId: string | null
  sku: string | null
  productDescription: string | null
  manufacturer: string | null
  manufacturerPartNumber: string | null
  cost: number | null
  matchConfidence: number | null
  matchBand: ConfidenceBand
  matchMethod: string | null
  matchReasoning: string | null
  alternatives: MatchAlternative[]
  requestedQty: number | null
  requestedUom: string | null
  quotedQty: number | null
  quotedUom: string | null
  uomConversionApplied: boolean
  uomConversionNote: string | null
  uomUnresolved: boolean
  listPrice: number | null
  unitPrice: number | null
  priceSource: string | null
  priceMissing: boolean
  lineMarginPercent: number | null
  marginLocked: boolean
  extendedPrice: number | null
  isSubstitution: boolean
  substitutedForText: string | null
  onHandQty: number | null
  stockShortfall: boolean
  leadTimeDays: number | null
  isFlagged: boolean
  flagReasons: string[]
  note: string | null
  isManual: boolean
}

export type ReviewQuote = {
  id: string
  rfqId: string
  quoteNumber: string | null
  status: string
  subtotal: number | null
  total: number | null
  terms: string | null
  validUntil: string | null
  deliveryNotes: string | null
  globalMarginPercent: number | null
  customerContactName: string | null
  customerContactEmail: string | null
  customerName: string | null
  jobName: string | null
  dueDate: string | null
  receivedAt: string
  deliveryAddress: string | null
  emailSubject: string | null
  emailFrom: string | null
  claimedBy: string | null
  claimedByName: string | null
}

/** A line plus everything the screen derives from its flags. Never stored. */
export type DecoratedLine = ReviewLine & {
  severity: Severity
  priority: Priority
  group: GroupKey
  issues: string[]
  explanation: string | null
}

export function decorate(line: ReviewLine): DecoratedLine {
  const reasons = line.isFlagged ? line.flagReasons : []
  return {
    ...line,
    severity: lineSeverity(reasons),
    priority: linePriority(reasons),
    group: lineGroup(reasons),
    issues: issueLabels(reasons),
    explanation: explanationOf(line),
  }
}

/**
 * The plain-language reason, in one sentence. The issue label carries the
 * colour; this carries the detail, so it is never red.
 */
function explanationOf(line: ReviewLine): string | null {
  const parts: string[] = []
  if (line.isSubstitution && line.substitutedForText) {
    parts.push(`They asked for ${line.substitutedForText}.`)
  }
  if (line.uomConversionNote) parts.push(line.uomConversionNote)
  if (line.note) parts.push(line.note)
  if (parts.length === 0 && !line.productId && line.matchReasoning) parts.push(line.matchReasoning)
  return parts.length > 0 ? parts.join(' ') : null
}

export type Counts = {
  total: number
  blocked: number
  review: number
  priced: number
  notStarted: number
  flagged: number
  unpriced: number
}

/**
 * The numbers behind the progress bar and the filter counts. All derived —
 * a stored count is a count that drifts.
 */
export function countLines(lines: DecoratedLine[]): Counts {
  const counts: Counts = {
    total: lines.length, blocked: 0, review: 0, priced: 0, notStarted: 0, flagged: 0, unpriced: 0,
  }
  for (const line of lines) {
    if (line.extendedPrice === null) counts.unpriced += 1
    if (line.isFlagged) {
      counts.flagged += 1
      if (line.severity === 'block') counts.blocked += 1
      else counts.review += 1
    } else if (line.extendedPrice !== null) {
      counts.priced += 1
    } else {
      counts.notStarted += 1
    }
  }
  return counts
}

/** Keeps the extended price honest while an edit is still only local. */
export function recompute(line: ReviewLine): ReviewLine {
  const extended =
    line.unitPrice === null || line.quotedQty === null
      ? null
      : Math.round(line.unitPrice * line.quotedQty * 100) / 100
  return { ...line, extendedPrice: extended }
}
