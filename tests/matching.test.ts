import { describe, expect, it } from 'vitest'
import {
  bandFor, descriptionOverlap, DEFAULT_THRESHOLDS, extractSpecs, matchLine, normalizeForMatch,
  scoreCandidate, specConflicts, type MatchCandidate, type MatchLine,
} from '@/lib/quote/matching'

function candidate(over: Partial<MatchCandidate> & Pick<MatchCandidate, 'productId' | 'sku' | 'description' | 'source'>): MatchCandidate {
  return { manufacturer: null, manufacturerPartNumber: null, upc: null, ...over }
}

const line: MatchLine = {
  rawText: '25 ea 1/2in EMT set screw connector',
  description: '1/2in EMT set screw connector',
  partNumber: null,
  manufacturer: null,
}

describe('normalizeForMatch', () => {
  it('collapses a line to the form corrections are keyed by', () => {
    expect(normalizeForMatch('  500FT of 12/2 MC Cable!! ')).toBe('500ft of 12/2 mc cable')
  })

  it('keeps the characters that carry meaning', () => {
    expect(normalizeForMatch('1/2" EMT #12 AWG')).toBe('1/2 emt #12 awg')
  })
})

describe('extractSpecs', () => {
  it('reads trade sizes', () => {
    expect([...extractSpecs('1/2in EMT connector').sizes]).toEqual(['1/2'])
    expect([...extractSpecs('3/4" rigid coupling').sizes]).toEqual(['3/4'])
  })

  it('reads conductor configurations', () => {
    expect([...extractSpecs('12/2 MC cable with ground').wire]).toEqual(['12/2'])
  })

  it('reads gauge, amps, volts and poles', () => {
    const specs = extractSpecs('QO 20A 120V 1P breaker #12 AWG')
    expect([...specs.amps]).toEqual(['20'])
    expect([...specs.volts]).toEqual(['120'])
    expect([...specs.poles]).toEqual(['1'])
    expect([...specs.gauge]).toEqual(['12'])
  })
})

describe('specConflicts', () => {
  it('catches the wrong trade size', () => {
    const conflicts = specConflicts('1/2in EMT connector', '3/4in EMT set screw connector')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatch(/size 1\/2 vs 3\/4/)
  })

  it('catches the wrong breaker rating', () => {
    expect(specConflicts('QO 20A 1P breaker', 'QO 30A 1P breaker')[0]).toMatch(/amps 20 vs 30/)
  })

  it('says nothing when the candidate omits the spec', () => {
    expect(specConflicts('1/2in EMT connector', 'EMT set screw connector')).toEqual([])
  })

  it('says nothing when they agree', () => {
    expect(specConflicts('1/2in EMT connector', '1/2 inch EMT set screw connector, steel')).toEqual([])
  })
})

describe('descriptionOverlap', () => {
  it('is high for the same product worded differently', () => {
    expect(descriptionOverlap('1/2in EMT set screw connector', 'EMT connector set screw 1/2')).toBeGreaterThan(0.6)
  })

  it('is low for different products', () => {
    expect(descriptionOverlap('1/2in EMT connector', 'QO120 circuit breaker')).toBeLessThan(0.15)
  })
})

describe('scoreCandidate', () => {
  it('puts a prior correction above everything else', () => {
    const scored = scoreCandidate(line, candidate({
      productId: 'p1', sku: 'EMT-CONN-12', description: '1/2 EMT set screw connector',
      source: 'correction', timesReinforced: 4,
    }))
    expect(scored.confidence).toBeGreaterThanOrEqual(0.99)
    expect(scored.reasoning).toMatch(/matched this wording to this product 4 times/)
  })

  it('rates an exact part number highly and says which one', () => {
    const scored = scoreCandidate(
      { ...line, partNumber: 'QO120', description: 'Square D QO120 breaker' },
      candidate({
        productId: 'p2', sku: 'SQD-QO120', description: 'QO 20A 1P breaker',
        manufacturerPartNumber: 'QO120', source: 'mpn',
      }),
    )
    expect(scored.confidence).toBeGreaterThan(0.9)
    expect(scored.reasoning).toMatch(/QO120 matches exactly/)
  })

  it('demotes a candidate whose size contradicts the line', () => {
    const right = scoreCandidate(line, candidate({
      productId: 'p1', sku: 'A', description: '1/2 EMT set screw connector', source: 'semantic', rawScore: 0.9,
    }))
    const wrong = scoreCandidate(line, candidate({
      productId: 'p2', sku: 'B', description: '3/4 EMT set screw connector', source: 'semantic', rawScore: 0.9,
    }))

    expect(wrong.confidence).toBeLessThan(right.confidence * 0.7)
    expect(wrong.conflicts).toHaveLength(1)
  })

  it('demotes even an exact part number when the specs disagree', () => {
    const scored = scoreCandidate(
      { rawText: '1/2in connector', description: '1/2in EMT connector', partNumber: 'X', manufacturer: null },
      candidate({
        productId: 'p1', sku: 'A', description: '3/4in EMT connector',
        manufacturerPartNumber: 'X', source: 'mpn',
      }),
    )
    expect(scored.confidence).toBeLessThan(DEFAULT_THRESHOLDS.high)
  })

  it('rewards a matching manufacturer and penalises a mismatched one', () => {
    const withLine: MatchLine = { ...line, manufacturer: 'hubbell' }
    const same = scoreCandidate(withLine, candidate({
      productId: 'p1', sku: 'A', description: '1/2 EMT connector', manufacturer: 'Hubbell',
      source: 'semantic', rawScore: 0.8,
    }))
    const different = scoreCandidate(withLine, candidate({
      productId: 'p2', sku: 'B', description: '1/2 EMT connector', manufacturer: 'Bridgeport',
      source: 'semantic', rawScore: 0.8,
    }))

    expect(same.confidence).toBeGreaterThan(different.confidence)
    expect(different.reasoning).toMatch(/Different manufacturer/)
  })
})

describe('bandFor', () => {
  it('splits on the tenant thresholds', () => {
    expect(bandFor(0.95, DEFAULT_THRESHOLDS)).toBe('high')
    expect(bandFor(0.8, DEFAULT_THRESHOLDS)).toBe('medium')
    expect(bandFor(0.6, DEFAULT_THRESHOLDS)).toBe('low')
    expect(bandFor(0.3, DEFAULT_THRESHOLDS)).toBe('no_match')
  })

  it('follows a tenant that tuned them', () => {
    const strict = { high: 0.98, medium: 0.9, low: 0.8 }
    expect(bandFor(0.95, strict)).toBe('medium')
  })
})

describe('matchLine', () => {
  it('flags a line with no candidates rather than picking something', () => {
    const result = matchLine(line, [])
    expect(result.productId).toBeNull()
    expect(result.band).toBe('no_match')
    expect(result.flagReasons).toContain('no_match')
  })

  it('lets a correction beat an exact part number', () => {
    const result = matchLine(
      { ...line, partNumber: 'ABC123' },
      [
        candidate({ productId: 'p-mpn', sku: 'B', description: '1/2 EMT connector', manufacturerPartNumber: 'ABC123', source: 'mpn' }),
        candidate({ productId: 'p-corr', sku: 'A', description: '1/2 EMT connector steel', source: 'correction', timesReinforced: 3 }),
      ],
    )
    expect(result.productId).toBe('p-corr')
    expect(result.method).toBe('correction')
    expect(result.band).toBe('high')
  })

  it('keeps one entry per product, taking its strongest signal', () => {
    const result = matchLine(line, [
      candidate({ productId: 'p1', sku: 'A', description: '1/2 EMT connector', source: 'semantic', rawScore: 0.7 }),
      candidate({ productId: 'p1', sku: 'A', description: '1/2 EMT connector', source: 'sku' }),
    ])
    expect(result.method).toBe('sku')
    expect(result.alternatives).toHaveLength(0)
  })

  it('returns alternatives whenever it is not sure', () => {
    const result = matchLine(line, [
      candidate({ productId: 'p1', sku: 'A', description: '1/2 EMT set screw connector', source: 'semantic', rawScore: 0.72 }),
      candidate({ productId: 'p2', sku: 'B', description: '1/2 EMT compression connector', source: 'semantic', rawScore: 0.68 }),
      candidate({ productId: 'p3', sku: 'C', description: '1/2 EMT coupling', source: 'semantic', rawScore: 0.6 }),
    ])

    expect(result.band).not.toBe('high')
    expect(result.alternatives.length).toBeGreaterThan(0)
    expect(result.alternatives.length).toBeLessThanOrEqual(5)
    expect(result.alternatives[0].product_id).not.toBe(result.productId)
  })

  it('offers no alternatives when it is certain', () => {
    const result = matchLine(line, [
      candidate({ productId: 'p1', sku: 'A', description: '1/2 EMT set screw connector', source: 'correction' }),
      candidate({ productId: 'p2', sku: 'B', description: '1/2 EMT coupling', source: 'semantic', rawScore: 0.4 }),
    ])
    expect(result.band).toBe('high')
    expect(result.alternatives).toEqual([])
  })

  it('flags a near-tie so a person decides', () => {
    const result = matchLine(line, [
      candidate({ productId: 'p1', sku: 'A', description: '1/2 EMT set screw connector steel', source: 'semantic', rawScore: 0.9 }),
      candidate({ productId: 'p2', sku: 'B', description: '1/2 EMT set screw connector zinc', source: 'semantic', rawScore: 0.9 }),
    ])
    expect(result.flagReasons).toContain('ambiguous')
    expect(result.alternatives.length).toBeGreaterThan(0)
  })

  it('explains its choice', () => {
    const result = matchLine(line, [
      candidate({ productId: 'p1', sku: 'EMT-12-SS', description: '1/2 EMT set screw connector', source: 'sku' }),
    ])
    expect(result.reasoning).toMatch(/SKU EMT-12-SS matches exactly/)
  })
})

describe('description-only matching', () => {
  // These numbers are the ones the live database actually returns for these
  // strings, measured against pg_trgm rather than guessed.
  it('recognises a correct match that trigram alone scores low', () => {
    const result = matchLine(
      { rawText: '500ft of 12/2 MC cable', description: '12/2 MC cable', partNumber: null, manufacturer: null },
      [candidate({
        productId: 'p1', sku: 'MC-12-2-250',
        description: '12/2 MC cable with ground, 250ft roll',
        source: 'trigram', rawScore: 0.389,
      })],
    )

    // A longer catalogue description drags trigram similarity down; the match
    // is still real, so it must reach the rep as a candidate rather than as
    // "nothing matched".
    expect(result.productId).toBe('p1')
    expect(result.band).not.toBe('no_match')
    expect(result.reasoning).toMatch(/Specification matches: conductors 12\/2/)
  })

  it('still separates the right size from the wrong one', () => {
    const result = matchLine(
      { rawText: '25 ea 1/2in EMT set screw connector', description: '1/2in EMT set screw connector', partNumber: null, manufacturer: null },
      [
        candidate({ productId: 'right', sku: 'EMT-12-SS', description: '1/2 EMT set screw connector, steel', source: 'trigram', rawScore: 0.743 }),
        candidate({ productId: 'wrong', sku: 'EMT-34-SS', description: '3/4 EMT set screw connector, steel', source: 'trigram', rawScore: 0.605 }),
      ],
    )

    expect(result.productId).toBe('right')
    expect(result.flagReasons).not.toContain('ambiguous')
  })

  it('keeps a correction ahead of an exact part number even so', () => {
    const result = matchLine(
      { rawText: 'x', description: '1/2in EMT connector', partNumber: 'ABC123', manufacturer: null },
      [
        candidate({ productId: 'p-mpn', sku: 'B', description: '1/2 EMT connector', manufacturerPartNumber: 'ABC123', source: 'mpn' }),
        candidate({ productId: 'p-corr', sku: 'A', description: '1/2 EMT connector steel', source: 'correction' }),
      ],
    )
    expect(result.productId).toBe('p-corr')
  })
})

describe('no_match still offers what it found', () => {
  it('does not drop the best candidate on the floor', () => {
    const result = matchLine(
      { rawText: 'blivet flange model ZZ', description: 'blivet flange model ZZ', partNumber: null, manufacturer: null },
      [
        candidate({ productId: 'p1', sku: 'A', description: 'flange gasket', source: 'trigram', rawScore: 0.2 }),
        candidate({ productId: 'p2', sku: 'B', description: 'pipe flange', source: 'trigram', rawScore: 0.15 }),
      ],
    )

    expect(result.band).toBe('no_match')
    expect(result.productId).toBeNull()
    // Nothing was good enough to quote, but the rep still gets the leads.
    expect(result.alternatives.map((a) => a.product_id)).toEqual(['p1', 'p2'])
  })
})
