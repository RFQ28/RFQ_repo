import type { ConfidenceBand, MatchAlternative } from '@/lib/db/types'
import { matchLine, type ConfidenceThresholds, type MatchCandidate, type MatchLine } from './matching'
import { priceLine, extendedPrice, marginOf, type ApplicableRule, type PricedProduct, type PriceSource } from './pricing'
import { convertQuantity, type UomProduct, type UomTables } from './uom'

/**
 * Turning parsed RFQ lines into a draft quote (PRD 6.4-6.7).
 *
 * Matching, unit conversion, pricing, stock and substitution all have to agree
 * on one line before a rep sees it, and every one of them can fail
 * independently. This assembles them and — the part that matters — collects
 * every reason the line needs attention into `flagReasons`, which is what the
 * review screen sorts on (6.9).
 *
 * The catalogue lookups are injected. That keeps the decision logic testable
 * without a database, and keeps the database queries in one place
 * (lib/quote/catalogue.ts) rather than scattered through the rules.
 */

export type DraftProduct = PricedProduct &
  UomProduct & {
    sku: string
    description: string
    manufacturerPartNumber: string | null
    upc: string | null
    on_hand_qty: number | null
    lead_time_days: number | null
    is_stocked: boolean
  }

export type SubstitutionOffer = {
  substitutionId: string
  product: DraftProduct
  requestedText: string
  relationship: string
}

/** What the orchestrator needs from the catalogue, however it is fetched. */
export type CataloguePorts = {
  /** Candidates from every search: corrections, part numbers, UPC, vector, trigram. */
  findCandidates(line: MatchLine): Promise<MatchCandidate[]>
  /** Full product rows for the ids a match produced. */
  loadProducts(productIds: string[]): Promise<Map<string, DraftProduct>>
  /** Equivalents from the tenant cross-reference, when nothing matched (6.7). */
  findSubstitutes(line: MatchLine): Promise<SubstitutionOffer[]>
  /** Price rules that could apply to this customer. */
  priceRules(): Promise<ApplicableRule[]>
}

export type DraftContext = {
  customerId: string | null
  jobName: string | null
  contractCodes?: string[]
  thresholds: ConfidenceThresholds
  uom: UomTables
  asOf?: Date
}

export type DraftLine = {
  rfqLineId: string | null
  lineNumber: number
  productId: string | null

  matchConfidence: number
  matchBand: ConfidenceBand
  matchMethod: string
  matchReasoning: string
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
  priceRuleId: string | null
  priceSource: PriceSource
  priceMissing: boolean
  priceExplanation: string
  lineMarginPercent: number | null
  extendedPrice: number | null

  isSubstitution: boolean
  substitutionId: string | null
  substitutedForText: string | null

  onHandQty: number | null
  stockShortfall: boolean
  leadTimeDays: number | null

  isFlagged: boolean
  flagReasons: string[]
}

export type DraftInputLine = {
  id: string | null
  lineNumber: number
  rawText: string
  description: string | null
  quantity: number | null
  uomAsWritten: string | null
  manufacturer: string | null
  partNumber: string | null
  isParsed: boolean
}

/** A line that could not be parsed is still a line. It just needs a person. */
function unparsedLine(line: DraftInputLine): DraftLine {
  return {
    rfqLineId: line.id,
    lineNumber: line.lineNumber,
    productId: null,
    matchConfidence: 0,
    matchBand: 'no_match',
    matchMethod: 'none',
    matchReasoning: 'This line could not be read from the document',
    alternatives: [],
    requestedQty: line.quantity,
    requestedUom: line.uomAsWritten,
    quotedQty: null,
    quotedUom: null,
    uomConversionApplied: false,
    uomConversionNote: null,
    uomUnresolved: false,
    listPrice: null,
    unitPrice: null,
    priceRuleId: null,
    priceSource: 'none',
    priceMissing: true,
    priceExplanation: 'Nothing to price until the line is matched',
    lineMarginPercent: null,
    extendedPrice: null,
    isSubstitution: false,
    substitutionId: null,
    substitutedForText: null,
    onHandQty: null,
    stockShortfall: false,
    leadTimeDays: null,
    isFlagged: true,
    flagReasons: ['unparsed'],
  }
}

export async function buildDraftLines(
  lines: DraftInputLine[],
  ports: CataloguePorts,
  context: DraftContext,
): Promise<DraftLine[]> {
  const rules = await ports.priceRules()
  const out: DraftLine[] = []

  for (const line of lines) {
    if (!line.isParsed || (!line.description && !line.partNumber)) {
      out.push(unparsedLine(line))
      continue
    }

    const matchInput: MatchLine = {
      rawText: line.rawText,
      description: line.description,
      partNumber: line.partNumber,
      manufacturer: line.manufacturer,
    }

    const candidates = await ports.findCandidates(matchInput)
    let match = matchLine(matchInput, candidates, context.thresholds)

    // Nothing stocked matches what they asked for. That is the moment a rep
    // reaches for an equivalent from memory, so the system offers one rather
    // than reporting a dead end (6.7).
    let substitution: SubstitutionOffer | null = null
    if (match.band === 'no_match') {
      const offers = await ports.findSubstitutes(matchInput)
      if (offers.length > 0) {
        substitution = offers[0]
        match = {
          productId: substitution.product.id,
          confidence: match.confidence,
          band: 'low',
          method: 'substitution' as never,
          reasoning:
            `No match for "${substitution.requestedText}". Offering ${substitution.product.sku} ` +
            `as an ${substitution.relationship}`,
          alternatives: offers.slice(1, 5).map((offer) => ({
            product_id: offer.product.id,
            sku: offer.product.sku,
            description: offer.product.description,
            confidence: 0,
            method: 'substitution',
            reasoning: `${offer.relationship} for ${offer.requestedText}`,
          })),
          flagReasons: ['substitution'],
        }
      }
    }

    const flagReasons = [...match.flagReasons]

    if (!match.productId) {
      out.push({
        ...unparsedLine(line),
        matchConfidence: match.confidence,
        matchReasoning: match.reasoning,
        alternatives: match.alternatives,
        flagReasons: flagReasons.length > 0 ? flagReasons : ['no_match'],
        priceExplanation: 'Nothing to price until the line is matched',
      })
      continue
    }

    const products = await ports.loadProducts([match.productId])
    const product = products.get(match.productId)

    if (!product) {
      out.push({
        ...unparsedLine(line),
        matchReasoning: 'The matched product is no longer in the catalogue',
        flagReasons: ['no_match'],
      })
      continue
    }

    const conversion = convertQuantity(line.quantity, line.uomAsWritten, product, context.uom)
    if (conversion.applied) flagReasons.push('uom_converted')
    if (conversion.unresolved) flagReasons.push('uom_unresolved')

    const price = priceLine(product, rules, {
      customerId: context.customerId,
      jobName: context.jobName,
      contractCodes: context.contractCodes,
      asOf: context.asOf,
    })
    flagReasons.push(...price.flagReasons)

    // Quoting something you cannot deliver is worse than being slow (6.7).
    const onHand = product.on_hand_qty
    const shortfall =
      conversion.quotedQty !== null && onHand !== null && conversion.quotedQty > onHand
    if (shortfall) flagReasons.push('stock_shortfall')
    if (!product.is_stocked) flagReasons.push('non_stock')

    const unique = [...new Set(flagReasons)]

    out.push({
      rfqLineId: line.id,
      lineNumber: line.lineNumber,
      productId: product.id,

      matchConfidence: match.confidence,
      matchBand: match.band,
      matchMethod: match.method,
      matchReasoning: match.reasoning,
      alternatives: match.alternatives,

      requestedQty: conversion.requestedQty,
      requestedUom: conversion.requestedUom,
      quotedQty: conversion.quotedQty,
      quotedUom: conversion.quotedUom,
      uomConversionApplied: conversion.applied,
      uomConversionNote: conversion.note,
      uomUnresolved: conversion.unresolved,

      listPrice: price.listPrice,
      unitPrice: price.unitPrice,
      priceRuleId: price.priceRuleId,
      priceSource: price.priceSource,
      priceMissing: price.priceMissing,
      priceExplanation: price.explanation,
      lineMarginPercent: marginOf(price.unitPrice, product.cost),
      extendedPrice: extendedPrice(price.unitPrice, conversion.quotedQty),

      isSubstitution: substitution !== null,
      substitutionId: substitution?.substitutionId ?? null,
      substitutedForText: substitution?.requestedText ?? null,

      onHandQty: onHand,
      stockShortfall: shortfall,
      leadTimeDays: product.lead_time_days,

      isFlagged: unique.length > 0,
      flagReasons: unique,
    })
  }

  return out
}

/**
 * How a flag reads on the review screen. Wording matters here: this is what a
 * rep skims eighty times a day.
 */
export const FLAG_LABELS: Record<string, string> = {
  unparsed: 'Could not read this line',
  no_match: 'No product matched',
  low_confidence: 'Unsure about this match',
  ambiguous: 'Two products fit equally well',
  spec_conflict: 'Specification does not match',
  substitution: 'Substitution offered',
  uom_converted: 'Quantity converted',
  uom_unresolved: 'Unit could not be converted',
  price_missing: 'No price',
  list_price_no_rule: 'List price — no customer rule',
  below_cost: 'Priced below cost',
  stock_shortfall: 'Not enough on hand',
  non_stock: 'Not a stocked item',
}

/** Everything the rep must look at, in the order they should look at it. */
export const FLAG_ORDER = [
  'unparsed', 'no_match', 'price_missing', 'uom_unresolved', 'spec_conflict',
  'stock_shortfall', 'low_confidence', 'ambiguous', 'substitution',
  'below_cost', 'uom_converted', 'list_price_no_rule', 'non_stock',
]

export function flagPriority(reasons: string[]): number {
  const best = reasons
    .map((reason) => FLAG_ORDER.indexOf(reason))
    .filter((index) => index >= 0)
  return best.length === 0 ? FLAG_ORDER.length : Math.min(...best)
}

export type DraftTotals = { subtotal: number; pricedLines: number; unpricedLines: number }

/**
 * Totals a draft.
 *
 * Unpriced lines are counted separately rather than treated as zero, because a
 * subtotal that quietly omits eleven lines is a subtotal nobody should send.
 */
export function totalDraft(lines: DraftLine[]): DraftTotals {
  let subtotal = 0
  let pricedLines = 0
  let unpricedLines = 0

  for (const line of lines) {
    if (line.extendedPrice === null) {
      unpricedLines += 1
      continue
    }
    subtotal += line.extendedPrice
    pricedLines += 1
  }

  return { subtotal: Math.round(subtotal * 100) / 100, pricedLines, unpricedLines }
}
