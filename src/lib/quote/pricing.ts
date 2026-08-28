import type { PriceRuleMethod, PriceRuleScope } from '@/lib/db/types'

/**
 * Customer-specific pricing (PRD 6.5).
 *
 * Distributors do not have one price. Contractor A pays list minus 22%,
 * contractor B list minus 30%, a third has a manufacturer special on one
 * product line for one job. If the draft prices everything at list, the rep
 * redoes every line and the system is worthless.
 *
 * The one rule that overrides every other consideration here: **never quietly
 * guess at a price.** A price we cannot derive is reported as missing and
 * flagged. A price derived from a rule says which rule, in words, on the line.
 */

export type ApplicableRule = {
  id: string
  scope: PriceRuleScope
  method: PriceRuleMethod
  value: number
  customer_id: string | null
  product_id: string | null
  category: string | null
  manufacturer: string | null
  contract_code: string | null
  job_name: string | null
  precedence: number
  effective_from: string | null
  effective_to: string | null
}

export type PricedProduct = {
  id: string
  category: string | null
  manufacturer: string | null
  list_price: number | null
  cost: number | null
}

export type PricingContext = {
  customerId: string | null
  jobName: string | null
  /** Contract codes this customer is entitled to. */
  contractCodes?: string[]
  /** Date the quote is priced as of. Defaults to today. */
  asOf?: Date
}

export type PriceSource = PriceRuleScope | 'list_no_rule' | 'manual' | 'none'

export type PriceResult = {
  unitPrice: number | null
  listPrice: number | null
  priceRuleId: string | null
  priceSource: PriceSource
  priceMissing: boolean
  /** Shown on hover, so every automated decision is inspectable (6.9). */
  explanation: string
  flagReasons: string[]
}

/**
 * How specific a rule is. A job price beats a customer-product price beats a
 * contract beats a category discount beats a blanket customer discount, because
 * that is the order a rep would apply them by hand.
 */
const SPECIFICITY: Record<PriceRuleScope, number> = {
  job: 50,
  customer_product: 40,
  contract: 30,
  customer_category: 20,
  customer: 10,
}

const METHOD_WORDS: Record<PriceRuleMethod, string> = {
  discount_percent_off_list: 'off list',
  multiplier_on_list: 'x list',
  fixed_price: 'fixed price',
  cost_plus_percent: 'over cost',
}

function withinDates(rule: ApplicableRule, asOf: Date): boolean {
  const day = asOf.toISOString().slice(0, 10)
  if (rule.effective_from && rule.effective_from > day) return false
  if (rule.effective_to && rule.effective_to < day) return false
  return true
}

function sameText(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** Whether a rule applies to this product for this customer, on this job. */
export function ruleApplies(
  rule: ApplicableRule,
  product: PricedProduct,
  context: PricingContext,
): boolean {
  const asOf = context.asOf ?? new Date()
  if (!withinDates(rule, asOf)) return false

  // A rule that names a product or category must match it, whatever its scope.
  if (rule.product_id && rule.product_id !== product.id) return false
  if (rule.category && !sameText(rule.category, product.category)) return false
  if (rule.manufacturer && !sameText(rule.manufacturer, product.manufacturer)) return false

  switch (rule.scope) {
    case 'customer':
    case 'customer_category':
    case 'customer_product':
      return rule.customer_id !== null && rule.customer_id === context.customerId

    case 'contract':
      return (
        rule.contract_code !== null &&
        (context.contractCodes ?? []).some((code) => sameText(code, rule.contract_code))
      )

    case 'job':
      return sameText(rule.job_name, context.jobName)
  }
}

/**
 * The winning rule, or null.
 *
 * Ties break on the admin-set `precedence` column first, so a distributor can
 * override this ordering without a code change, then on specificity, then on
 * the latest effective date.
 */
export function selectRule(
  rules: ApplicableRule[],
  product: PricedProduct,
  context: PricingContext,
): ApplicableRule | null {
  const applicable = rules.filter((rule) => ruleApplies(rule, product, context))
  if (applicable.length === 0) return null

  return applicable.reduce((best, rule) => {
    if (rule.precedence !== best.precedence) return rule.precedence > best.precedence ? rule : best
    const a = SPECIFICITY[rule.scope]
    const b = SPECIFICITY[best.scope]
    if (a !== b) return a > b ? rule : best
    return (rule.effective_from ?? '') > (best.effective_from ?? '') ? rule : best
  })
}

function money(value: number): number {
  return Math.round(value * 10000) / 10000
}

function describeRule(rule: ApplicableRule): string {
  const scope =
    rule.scope === 'job' ? `job "${rule.job_name}"`
    : rule.scope === 'contract' ? `contract ${rule.contract_code}`
    : rule.scope === 'customer_product' ? 'this customer, this product'
    : rule.scope === 'customer_category' ? `this customer, ${rule.category}`
    : 'this customer'

  const amount =
    rule.method === 'fixed_price' ? `$${rule.value}`
    : rule.method === 'multiplier_on_list' ? `${rule.value}`
    : `${rule.value}%`

  return `${amount} ${METHOD_WORDS[rule.method]} (${scope})`
}

/**
 * Prices one line.
 *
 * Where no rule is found the list price is used and the line says so, which is
 * the honest answer -- a rep can accept list, but only if they know that is
 * what they are looking at.
 */
export function priceLine(
  product: PricedProduct,
  rules: ApplicableRule[],
  context: PricingContext,
): PriceResult {
  const listPrice = product.list_price
  const rule = selectRule(rules, product, context)

  if (!rule) {
    if (listPrice === null) {
      return {
        unitPrice: null,
        listPrice: null,
        priceRuleId: null,
        priceSource: 'none',
        priceMissing: true,
        explanation: 'No customer price rule and no list price in the catalogue',
        flagReasons: ['price_missing'],
      }
    }
    return {
      unitPrice: money(listPrice),
      listPrice,
      priceRuleId: null,
      priceSource: 'list_no_rule',
      priceMissing: false,
      explanation: 'List price — no customer rule found',
      flagReasons: ['list_price_no_rule'],
    }
  }

  const needsList = rule.method === 'discount_percent_off_list' || rule.method === 'multiplier_on_list'
  if (needsList && listPrice === null) {
    return {
      unitPrice: null,
      listPrice: null,
      priceRuleId: rule.id,
      priceSource: rule.scope,
      priceMissing: true,
      explanation: `${describeRule(rule)} applies, but the catalogue has no list price to apply it to`,
      flagReasons: ['price_missing'],
    }
  }

  if (rule.method === 'cost_plus_percent' && product.cost === null) {
    return {
      unitPrice: null,
      listPrice,
      priceRuleId: rule.id,
      priceSource: rule.scope,
      priceMissing: true,
      explanation: `${describeRule(rule)} applies, but the catalogue has no cost to apply it to`,
      flagReasons: ['price_missing'],
    }
  }

  let unitPrice: number
  switch (rule.method) {
    case 'discount_percent_off_list':
      unitPrice = listPrice! * (1 - rule.value / 100)
      break
    case 'multiplier_on_list':
      unitPrice = listPrice! * rule.value
      break
    case 'fixed_price':
      unitPrice = rule.value
      break
    case 'cost_plus_percent':
      unitPrice = product.cost! * (1 + rule.value / 100)
      break
  }

  const flagReasons: string[] = []
  // A rule that prices below cost is legal but is nearly always a bad import.
  if (product.cost !== null && unitPrice < product.cost) {
    flagReasons.push('below_cost')
  }

  return {
    unitPrice: money(unitPrice),
    listPrice,
    priceRuleId: rule.id,
    priceSource: rule.scope,
    priceMissing: false,
    explanation: describeRule(rule),
    flagReasons,
  }
}

// ---------------------------------------------------------------------------
// Margin (6.9)
// ---------------------------------------------------------------------------

/** Sell price that yields `marginPercent` gross margin on `cost`. */
export function priceFromMargin(cost: number, marginPercent: number): number | null {
  if (marginPercent >= 100) return null
  return money(cost / (1 - marginPercent / 100))
}

/** Gross margin a price represents, or null when cost is unknown. */
export function marginOf(unitPrice: number | null, cost: number | null): number | null {
  if (unitPrice === null || cost === null || unitPrice === 0) return null
  return Math.round(((unitPrice - cost) / unitPrice) * 1000) / 10
}

export function extendedPrice(unitPrice: number | null, quantity: number | null): number | null {
  if (unitPrice === null || quantity === null) return null
  return Math.round(unitPrice * quantity * 100) / 100
}

/**
 * Applies a quote-level margin to the lines that accept it.
 *
 * A line the rep has locked keeps its price -- that is what locking is for --
 * and a line with no cost cannot be priced from margin at all, so it is left
 * alone and reported rather than silently skipped.
 */
export function applyGlobalMargin<T extends { cost: number | null; marginLocked: boolean; id: string }>(
  lines: T[],
  marginPercent: number,
): { id: string; unitPrice: number | null; skipped: 'locked' | 'no_cost' | null }[] {
  return lines.map((line) => {
    if (line.marginLocked) return { id: line.id, unitPrice: null, skipped: 'locked' as const }
    if (line.cost === null) return { id: line.id, unitPrice: null, skipped: 'no_cost' as const }
    return { id: line.id, unitPrice: priceFromMargin(line.cost, marginPercent), skipped: null }
  })
}
