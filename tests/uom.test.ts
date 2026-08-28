import { describe, expect, it } from 'vitest'
import { buildUomTables, canonicalUom, conversionFactor, convertQuantity } from '@/lib/quote/uom'

// The table a tenant is seeded with at provisioning (migration 0006).
const tables = buildUomTables(
  [
    { alias: 'ft', uom: 'FT' }, { alias: 'feet', uom: 'FT' }, { alias: 'lf', uom: 'FT' },
    { alias: 'linear feet', uom: 'FT' },
    { alias: 'mft', uom: 'MFT' }, { alias: 'ea', uom: 'EA' }, { alias: 'each', uom: 'EA' },
    { alias: 'roll', uom: 'ROLL' }, { alias: 'box', uom: 'BOX' }, { alias: 'lb', uom: 'LB' },
    { alias: 'yd', uom: 'YD' },
  ],
  [
    { from_uom: 'MFT', to_uom: 'FT', factor: 1000 },
    { from_uom: 'CFT', to_uom: 'FT', factor: 100 },
    { from_uom: 'YD', to_uom: 'FT', factor: 3 },
    { from_uom: 'CWT', to_uom: 'LB', factor: 100 },
    { from_uom: 'DOZ', to_uom: 'EA', factor: 12 },
  ],
)

const roll = { uom: 'ROLL', unitsPerPackage: 250, baseUom: 'FT' }
const perMft = { uom: 'MFT', unitsPerPackage: null, baseUom: null }
const each = { uom: 'EA', unitsPerPackage: null, baseUom: null }

describe('canonicalUom', () => {
  it('maps what contractors write onto canonical codes', () => {
    expect(canonicalUom('ft', tables)).toBe('FT')
    expect(canonicalUom('Linear Feet', tables)).toBe('FT')
    expect(canonicalUom('LF', tables)).toBe('FT')
    expect(canonicalUom('EA.', tables)).toBe('EA')
  })

  it('passes an unknown unit through rather than assuming', () => {
    expect(canonicalUom('blivets', tables)).toBe('BLIVETS')
    expect(canonicalUom(null, tables)).toBeNull()
    expect(canonicalUom('  ', tables)).toBeNull()
  })
})

describe('conversionFactor', () => {
  it('reads the table in both directions', () => {
    expect(conversionFactor('MFT', 'FT', tables)).toBe(1000)
    expect(conversionFactor('FT', 'MFT', tables)).toBe(0.001)
  })

  it('chains hops the table does not state directly', () => {
    // MFT -> FT -> YD, which no row expresses on its own.
    expect(conversionFactor('MFT', 'YD', tables)).toBeCloseTo(1000 / 3, 6)
  })

  it('returns null across dimensions rather than a wrong number', () => {
    expect(conversionFactor('FT', 'LB', tables)).toBeNull()
    expect(conversionFactor('FT', 'EA', tables)).toBeNull()
  })

  it('is 1 for a unit onto itself', () => {
    expect(conversionFactor('FT', 'FT', tables)).toBe(1)
  })
})

describe('convertQuantity', () => {
  it('leaves a matching unit alone', () => {
    const result = convertQuantity(500, 'ft', { uom: 'FT', unitsPerPackage: null, baseUom: null }, tables)
    expect(result).toMatchObject({ quotedQty: 500, quotedUom: 'FT', applied: false, note: null })
  })

  it('converts feet to the thousand-feet the catalogue prices in', () => {
    const result = convertQuantity(500, 'ft', perMft, tables)
    expect(result.quotedQty).toBe(0.5)
    expect(result.quotedUom).toBe('MFT')
    expect(result.applied).toBe(true)
    expect(result.note).toMatch(/500 FT requested; quoting 0.5 MFT/)
  })

  it('rounds up to whole rolls and says how many feet that is', () => {
    const result = convertQuantity(500, 'ft', roll, tables)
    expect(result.quotedQty).toBe(2)
    expect(result.quotedUom).toBe('ROLL')
    expect(result.applied).toBe(true)
    expect(result.note).toMatch(/500 FT requested; quoting 2 ROLL of 250 FT \(500 FT total\)/)
  })

  it('never rounds a partial package down', () => {
    // 300ft is one and a bit rolls; quoting one roll would short the job.
    expect(convertQuantity(300, 'ft', roll, tables).quotedQty).toBe(2)
    expect(convertQuantity(251, 'ft', roll, tables).quotedQty).toBe(2)
    expect(convertQuantity(250, 'ft', roll, tables).quotedQty).toBe(1)
  })

  it('flags a package product with no package size instead of guessing', () => {
    const result = convertQuantity(500, 'ft', { uom: 'ROLL', unitsPerPackage: null, baseUom: 'FT' }, tables)
    expect(result.unresolved).toBe(true)
    expect(result.quotedQty).toBeNull()
    expect(result.note).toMatch(/does not say how many/)
  })

  it('flags a unit it cannot convert instead of guessing', () => {
    const result = convertQuantity(40, 'lb', perMft, tables)
    expect(result.unresolved).toBe(true)
    expect(result.quotedQty).toBeNull()
    expect(result.note).toMatch(/No conversion from LB to MFT/)
  })

  it('reads a bare quantity as the selling unit, and says so', () => {
    const result = convertQuantity(25, null, each, tables)
    expect(result.quotedQty).toBe(25)
    expect(result.applied).toBe(false)
    expect(result.note).toMatch(/No unit given — read as 25 EA/)
  })

  it('rounds a discrete unit up but leaves a measure alone', () => {
    expect(convertQuantity(30, 'ft', { uom: 'EA', unitsPerPackage: 1, baseUom: 'EA' }, tables).quotedQty).toBeNull()
    expect(convertQuantity(1, 'doz', each, tables).quotedQty).toBe(12)
    expect(convertQuantity(1250, 'ft', perMft, tables).quotedQty).toBe(1.25)
  })

  it('keeps the requested quantity visible next to the quoted one', () => {
    const result = convertQuantity(500, 'ft', roll, tables)
    expect(result.requestedQty).toBe(500)
    expect(result.requestedUom).toBe('FT')
    expect(result.quotedQty).toBe(2)
  })

  it('has nothing to convert when no quantity was given', () => {
    const result = convertQuantity(null, 'ft', roll, tables)
    expect(result.quotedQty).toBeNull()
    expect(result.unresolved).toBe(false)
  })

  it('converts a customer unit the table only reaches by two hops', () => {
    // yards to rolls: YD -> FT -> 250ft rolls
    const result = convertQuantity(100, 'yd', roll, tables)
    expect(result.quotedQty).toBe(2) // 300ft
  })
})
