import { describe, expect, it } from 'vitest'
import {
  buildDraftLines, flagPriority, totalDraft,
  type CataloguePorts, type DraftContext, type DraftInputLine, type DraftProduct, type SubstitutionOffer,
} from '@/lib/quote/draft'
import { DEFAULT_THRESHOLDS, type MatchCandidate } from '@/lib/quote/matching'
import { buildUomTables } from '@/lib/quote/uom'
import type { ApplicableRule } from '@/lib/quote/pricing'

const uom = buildUomTables(
  [{ alias: 'ft', uom: 'FT' }, { alias: 'ea', uom: 'EA' }],
  [{ from_uom: 'MFT', to_uom: 'FT', factor: 1000 }],
)

function product(over: Partial<DraftProduct> & Pick<DraftProduct, 'id' | 'sku' | 'description'>): DraftProduct {
  return {
    category: null, manufacturer: null, list_price: 100, cost: 60,
    manufacturerPartNumber: null, upc: null,
    uom: 'EA', unitsPerPackage: null, baseUom: null,
    on_hand_qty: 1000, lead_time_days: null, is_stocked: true,
    ...over,
  }
}

const romex = product({
  id: 'p-romex', sku: 'MC-12-2', description: '12/2 MC cable with ground',
  uom: 'ROLL', unitsPerPackage: 250, baseUom: 'FT', on_hand_qty: 4,
})

const connector = product({
  id: 'p-conn', sku: 'EMT-12-SS', description: '1/2 EMT set screw connector',
})

function ports(over: Partial<CataloguePorts> = {}): CataloguePorts {
  const catalogue = new Map<string, DraftProduct>([
    [romex.id, romex],
    [connector.id, connector],
  ])
  return {
    findCandidates: async () => [],
    loadProducts: async (ids) => new Map(ids.filter((id) => catalogue.has(id)).map((id) => [id, catalogue.get(id)!])),
    findSubstitutes: async () => [],
    priceRules: async () => [],
    ...over,
  }
}

const context: DraftContext = {
  customerId: 'c1',
  jobName: null,
  thresholds: DEFAULT_THRESHOLDS,
  uom,
}

function inputLine(over: Partial<DraftInputLine> = {}): DraftInputLine {
  return {
    id: 'l1', lineNumber: 1, rawText: '500ft of 12/2 MC cable',
    description: '12/2 MC cable', quantity: 500, uomAsWritten: 'ft',
    manufacturer: null, partNumber: null, isParsed: true,
    ...over,
  }
}

const skuCandidate: MatchCandidate = {
  productId: romex.id, sku: romex.sku, description: romex.description,
  manufacturer: null, manufacturerPartNumber: null, upc: null, source: 'sku',
}

describe('buildDraftLines', () => {
  it('matches, converts, prices and totals one line', async () => {
    const rules: ApplicableRule[] = [{
      id: 'r1', scope: 'customer', method: 'discount_percent_off_list', value: 22,
      customer_id: 'c1', product_id: null, category: null, manufacturer: null,
      contract_code: null, job_name: null, precedence: 0,
      effective_from: null, effective_to: null,
    }]

    const [line] = await buildDraftLines(
      [inputLine()],
      ports({ findCandidates: async () => [skuCandidate], priceRules: async () => rules }),
      context,
    )

    expect(line.productId).toBe(romex.id)
    expect(line.matchBand).toBe('high')
    // 500ft off 250ft rolls, rounded up
    expect(line.quotedQty).toBe(2)
    expect(line.quotedUom).toBe('ROLL')
    expect(line.uomConversionApplied).toBe(true)
    expect(line.unitPrice).toBe(78)
    expect(line.extendedPrice).toBe(156)
    expect(line.lineMarginPercent).toBeCloseTo(23.1, 1)
  })

  it('flags a converted quantity so it is never silent', async () => {
    const [line] = await buildDraftLines(
      [inputLine()],
      ports({ findCandidates: async () => [skuCandidate] }),
      context,
    )
    expect(line.flagReasons).toContain('uom_converted')
    expect(line.isFlagged).toBe(true)
    expect(line.uomConversionNote).toMatch(/500 FT requested; quoting 2 ROLL/)
  })

  it('keeps an unparsed line as a flagged row rather than dropping it', async () => {
    const [line] = await buildDraftLines(
      [inputLine({ isParsed: false, description: null })],
      ports(),
      context,
    )
    expect(line.productId).toBeNull()
    expect(line.flagReasons).toContain('unparsed')
    expect(line.isFlagged).toBe(true)
  })

  it('flags a line nothing matched', async () => {
    const [line] = await buildDraftLines([inputLine()], ports(), context)
    expect(line.productId).toBeNull()
    expect(line.matchBand).toBe('no_match')
    expect(line.flagReasons).toContain('no_match')
  })

  it('offers a substitution when nothing matched, and labels it', async () => {
    const offer: SubstitutionOffer = {
      substitutionId: 's1',
      product: connector,
      requestedText: 'Bridgeport 230-SST',
      relationship: 'equivalent',
    }

    const [line] = await buildDraftLines(
      [inputLine({ description: 'Bridgeport 230-SST connector', quantity: 25, uomAsWritten: 'ea' })],
      ports({ findSubstitutes: async () => [offer] }),
      context,
    )

    expect(line.productId).toBe(connector.id)
    expect(line.isSubstitution).toBe(true)
    expect(line.substitutedForText).toBe('Bridgeport 230-SST')
    expect(line.flagReasons).toContain('substitution')
    expect(line.matchReasoning).toMatch(/Offering EMT-12-SS as an equivalent/)
  })

  it('flags a line it cannot price', async () => {
    const noPrice = { ...romex, list_price: null }
    const [line] = await buildDraftLines(
      [inputLine()],
      ports({
        findCandidates: async () => [skuCandidate],
        loadProducts: async () => new Map([[romex.id, noPrice]]),
      }),
      context,
    )

    expect(line.unitPrice).toBeNull()
    expect(line.priceMissing).toBe(true)
    expect(line.flagReasons).toContain('price_missing')
    expect(line.extendedPrice).toBeNull()
  })

  it('marks a list-price line as such', async () => {
    const [line] = await buildDraftLines(
      [inputLine()],
      ports({ findCandidates: async () => [skuCandidate] }),
      context,
    )
    expect(line.priceSource).toBe('list_no_rule')
    expect(line.flagReasons).toContain('list_price_no_rule')
    expect(line.priceExplanation).toMatch(/no customer rule/)
  })

  it('flags a quantity larger than what is on hand', async () => {
    const [line] = await buildDraftLines(
      [inputLine({ quantity: 2000 })], // 8 rolls against 4 on hand
      ports({ findCandidates: async () => [skuCandidate] }),
      context,
    )
    expect(line.quotedQty).toBe(8)
    expect(line.onHandQty).toBe(4)
    expect(line.stockShortfall).toBe(true)
    expect(line.flagReasons).toContain('stock_shortfall')
  })

  it('leaves a clean line unflagged', async () => {
    const [line] = await buildDraftLines(
      [inputLine({ description: '1/2 EMT set screw connector', quantity: 25, uomAsWritten: 'ea', rawText: '25 ea 1/2 EMT set screw connector' })],
      ports({
        findCandidates: async () => [{
          productId: connector.id, sku: connector.sku, description: connector.description,
          manufacturer: null, manufacturerPartNumber: null, upc: null, source: 'correction',
        }],
        priceRules: async () => [{
          id: 'r1', scope: 'customer', method: 'discount_percent_off_list', value: 22,
          customer_id: 'c1', product_id: null, category: null, manufacturer: null,
          contract_code: null, job_name: null, precedence: 0,
          effective_from: null, effective_to: null,
        }],
      }),
      context,
    )

    expect(line.matchBand).toBe('high')
    expect(line.isFlagged).toBe(false)
    expect(line.flagReasons).toEqual([])
  })

  it('keeps lines in the order they were written', async () => {
    const lines = await buildDraftLines(
      [inputLine({ id: 'a', lineNumber: 1 }), inputLine({ id: 'b', lineNumber: 2 }), inputLine({ id: 'c', lineNumber: 3 })],
      ports(),
      context,
    )
    expect(lines.map((l) => l.lineNumber)).toEqual([1, 2, 3])
  })
})

describe('totalDraft', () => {
  it('counts unpriced lines instead of treating them as zero', () => {
    const totals = totalDraft([
      { extendedPrice: 156 }, { extendedPrice: 44.5 }, { extendedPrice: null },
    ] as Parameters<typeof totalDraft>[0])

    expect(totals).toEqual({ subtotal: 200.5, pricedLines: 2, unpricedLines: 1 })
  })
})

describe('flagPriority', () => {
  it('puts what a rep must fix above what they only need to notice', () => {
    expect(flagPriority(['no_match'])).toBeLessThan(flagPriority(['uom_converted']))
    expect(flagPriority(['price_missing'])).toBeLessThan(flagPriority(['list_price_no_rule']))
    expect(flagPriority(['unparsed'])).toBeLessThan(flagPriority(['low_confidence']))
  })

  it('takes the most urgent reason on a line with several', () => {
    expect(flagPriority(['uom_converted', 'no_match'])).toBe(flagPriority(['no_match']))
  })

  it('sorts an unflagged line last', () => {
    expect(flagPriority([])).toBeGreaterThan(flagPriority(['non_stock']))
  })
})
