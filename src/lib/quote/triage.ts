import { FLAG_ORDER, FLAG_LABELS } from './draft'

/**
 * Turning a line's flag reasons into the two things the review screen renders:
 * how loud the line should be, and which pile it belongs in.
 *
 * The severity ladder is the only thing that spends colour. `block` means the
 * quote cannot be sent until the rep does something; `warn` means it can be
 * sent but somebody should look; `ok` means the flag is informational.
 *
 * The groups are by *cause*, not by line number, because a rep who is
 * confirming eight lead times is in one mental mode and should not have to
 * re-enter it eight times.
 */

export type Severity = 'block' | 'warn' | 'ok'
export type Priority = 'blocked' | 'high' | 'medium' | 'low'
export type GroupKey = 'unmatched' | 'price' | 'stock' | 'confidence' | 'pricing' | 'quantity' | 'other'

type FlagFacts = { priority: Priority; group: GroupKey }

const FLAGS: Record<string, FlagFacts> = {
  unparsed: { priority: 'blocked', group: 'unmatched' },
  no_match: { priority: 'blocked', group: 'unmatched' },
  price_missing: { priority: 'blocked', group: 'price' },
  uom_unresolved: { priority: 'blocked', group: 'price' },
  spec_conflict: { priority: 'high', group: 'confidence' },
  stock_shortfall: { priority: 'high', group: 'stock' },
  low_confidence: { priority: 'high', group: 'confidence' },
  ambiguous: { priority: 'high', group: 'confidence' },
  substitution: { priority: 'medium', group: 'confidence' },
  below_cost: { priority: 'medium', group: 'pricing' },
  non_stock: { priority: 'medium', group: 'stock' },
  uom_converted: { priority: 'low', group: 'quantity' },
  list_price_no_rule: { priority: 'low', group: 'pricing' },
}

const PRIORITY_RANK: Record<Priority, number> = { blocked: 0, high: 1, medium: 2, low: 3 }

export const GROUPS: { key: GroupKey; label: string; hint: string; severity: Severity }[] = [
  {
    key: 'unmatched',
    label: 'Nothing matched',
    hint: 'enter by hand or search the catalogue',
    severity: 'block',
  },
  {
    key: 'price',
    label: 'Missing price or unit',
    hint: 'blocks the total until resolved',
    severity: 'block',
  },
  {
    key: 'stock',
    label: 'Availability risk',
    hint: 'confirm lead time before you commit',
    severity: 'warn',
  },
  {
    key: 'confidence',
    label: 'Match confidence',
    hint: 'review the substitution or spec',
    severity: 'warn',
  },
  {
    key: 'pricing',
    label: 'Pricing to check',
    hint: 'no customer rule fired, or the margin is thin',
    severity: 'warn',
  },
  {
    key: 'quantity',
    label: 'Quantity converted',
    hint: 'confirm the unit conversion held',
    severity: 'ok',
  },
  { key: 'other', label: 'Other flags', hint: '', severity: 'ok' },
]

/** The flag that decides how the line is filed: the most urgent one it carries. */
export function leadFlag(reasons: string[]): string | null {
  let best: string | null = null
  let bestRank = Number.POSITIVE_INFINITY
  for (const reason of reasons) {
    const rank = FLAG_ORDER.indexOf(reason)
    if (rank >= 0 && rank < bestRank) {
      bestRank = rank
      best = reason
    }
  }
  return best ?? reasons[0] ?? null
}

export function linePriority(reasons: string[]): Priority {
  let worst: Priority = 'low'
  let seen = false
  for (const reason of reasons) {
    const facts = FLAGS[reason]
    if (!facts) continue
    seen = true
    if (PRIORITY_RANK[facts.priority] < PRIORITY_RANK[worst]) worst = facts.priority
  }
  // An unrecognised flag is still a flag; treat it as worth a look.
  return seen ? worst : reasons.length > 0 ? 'medium' : 'low'
}

export function lineSeverity(reasons: string[]): Severity {
  if (reasons.length === 0) return 'ok'
  const priority = linePriority(reasons)
  if (priority === 'blocked') return 'block'
  if (priority === 'low') return 'ok'
  return 'warn'
}

export function lineGroup(reasons: string[]): GroupKey {
  const lead = leadFlag(reasons)
  if (!lead) return 'other'
  return FLAGS[lead]?.group ?? 'other'
}

export function issueLabels(reasons: string[]): string[] {
  return reasons.map((reason) => FLAG_LABELS[reason] ?? reason.replace(/_/g, ' '))
}

/** "2 days left", "due today", "3 days late" — the actionable half of a date. */
export function dueRelative(dueDate: string | null, today = new Date()): string | null {
  if (!dueDate) return null
  const due = new Date(`${dueDate}T00:00:00`)
  if (Number.isNaN(due.getTime())) return null
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const days = Math.round((due.getTime() - midnight.getTime()) / 86_400_000)
  if (days === 0) return 'due today'
  if (days === 1) return '1 day left'
  if (days > 1) return `${days} days left`
  if (days === -1) return '1 day late'
  return `${Math.abs(days)} days late`
}
