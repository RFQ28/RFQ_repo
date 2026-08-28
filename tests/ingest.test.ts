import { describe, expect, it } from 'vitest'
import { parseCsv } from '@/lib/ingest/tabular'
import { guessMapping, missingRequired, applyMapping } from '@/lib/ingest/mapping'
import { toDate, toMoney, toNumber, toUom } from '@/lib/ingest/coerce'
import { resolvePriceMethod, validateRow, validateSheet } from '@/lib/ingest/validate'
import { diffImport, naturalKey, type ExistingRow } from '@/lib/ingest/diff'

describe('coercion', () => {
  it('reads money as exports write it', () => {
    expect(toMoney('$1,234.56', 'p')).toBe(1234.56)
    expect(toMoney('1234.56', 'p')).toBe(1234.56)
    expect(toMoney('(12.00)', 'p')).toBe(-12)
    expect(toMoney('-5', 'p')).toBe(-5)
    expect(toMoney('1.234,56', 'p')).toBe(1234.56)
    expect(toMoney('', 'p')).toBeUndefined()
    expect(toMoney('n/a', 'p')).toBeUndefined()
  })

  it('refuses to turn an unreadable price into null', () => {
    expect(() => toMoney('call for pricing', 'List price')).toThrow(/not a price/)
    expect(() => toNumber('abc', 'Qty')).toThrow(/not a number/)
  })

  it('canonicalises units and leaves unknown ones alone', () => {
    expect(toUom('ft')).toBe('FT')
    expect(toUom('Linear Feet')).toBe('FT')
    expect(toUom('MFT')).toBe('MFT')
    expect(toUom('C')).toBe('C')
    expect(toUom('blivet')).toBe('BLIVET')
  })

  it('reads the date formats an ERP export produces', () => {
    expect(toDate('2026-03-01', 'd')).toBe('2026-03-01')
    expect(toDate('3/1/2026', 'd')).toBe('2026-03-01')
    expect(toDate('3/1/26', 'd')).toBe('2026-03-01')
    expect(toDate('45717', 'd')).toBe('2025-03-01')
    expect(() => toDate('whenever', 'Effective from')).toThrow(/not a date/)
  })
})

describe('column mapping', () => {
  const headers = ['Item Number', 'Item Description', 'MFG', 'MFG Part Number', 'List Price', 'UOM', 'QTY ON HAND']

  it('guesses an export layout', () => {
    const mapping = guessMapping(headers, 'products')
    expect(mapping.sku).toBe('Item Number')
    expect(mapping.description).toBe('Item Description')
    expect(mapping.manufacturer).toBe('MFG')
    expect(mapping.manufacturer_part_number).toBe('MFG Part Number')
    expect(mapping.list_price).toBe('List Price')
    expect(mapping.on_hand_qty).toBe('QTY ON HAND')
    expect(missingRequired(mapping, 'products')).toEqual([])
  })

  it('does not assign one column to two fields', () => {
    const mapping = guessMapping(headers, 'products')
    const used = Object.values(mapping)
    expect(new Set(used).size).toBe(used.length)
  })

  it('reports what a mapping is missing rather than importing half a row', () => {
    const mapping = guessMapping(['Widget', 'Amount'], 'products')
    const missing = missingRequired(mapping, 'products')
    expect(missing.map((m) => m.field).sort()).toEqual(['description', 'sku'])
  })
})

describe('product validation', () => {
  const mapping = { sku: 'SKU', description: 'Description', list_price: 'List', uom: 'UOM', units_per_package: 'Pack' }

  it('accepts a good row', () => {
    const row = validateRow(
      { SKU: '12-2NMWG', Description: '12/2 NM-B With Ground', List: '$189.50', UOM: 'MFT', Pack: '' },
      1, { kind: 'products', mapping },
    )
    expect(row.isValid).toBe(true)
    expect(row.normalized).toMatchObject({ sku: '12-2NMWG', list_price: 189.5, uom: 'MFT' })
  })

  it('warns when a package unit carries no package size', () => {
    const row = validateRow(
      { SKU: 'X', Description: 'Wire', List: '10', UOM: 'ROLL', Pack: '' },
      1, { kind: 'products', mapping },
    )
    expect(row.isValid).toBe(true)
    expect(row.warnings.join(' ')).toMatch(/units-per-package/)
  })

  it('warns rather than invents when there is no list price', () => {
    const row = validateRow(
      { SKU: 'X', Description: 'Wire', List: '', UOM: 'EA', Pack: '' },
      1, { kind: 'products', mapping },
    )
    expect(row.isValid).toBe(true)
    expect(row.normalized?.list_price).toBeNull()
    expect(row.warnings.join(' ')).toMatch(/No list price/)
  })

  it('fails a row whose price cannot be read', () => {
    const row = validateRow(
      { SKU: 'X', Description: 'Wire', List: 'call', UOM: 'EA', Pack: '' },
      1, { kind: 'products', mapping },
    )
    expect(row.isValid).toBe(false)
    expect(row.normalized).toBeNull()
  })

  it('catches a duplicate SKU inside one file', () => {
    const rows = [
      { SKU: 'A1', Description: 'One', List: '1', UOM: 'EA', Pack: '' },
      { SKU: 'a1', Description: 'One again', List: '2', UOM: 'EA', Pack: '' },
    ]
    const validated = validateSheet(rows, { kind: 'products', mapping })
    expect(validated[0].isValid).toBe(true)
    expect(validated[1].isValid).toBe(false)
    expect(validated[1].errors.join(' ')).toMatch(/Duplicate of row 1/)
  })
})

describe('price rule validation', () => {
  it('reads the method from an explicit column', () => {
    expect(resolvePriceMethod('Discount', undefined)).toBe('discount_percent_off_list')
    expect(resolvePriceMethod('Multiplier', undefined)).toBe('multiplier_on_list')
    expect(resolvePriceMethod('Net Price', undefined)).toBe('fixed_price')
  })

  it('falls back to the header the value came from', () => {
    expect(resolvePriceMethod(undefined, 'Discount %')).toBe('discount_percent_off_list')
    expect(resolvePriceMethod('', 'Col 1 Price')).toBe('fixed_price')
  })

  it('refuses an ambiguous value column instead of guessing', () => {
    expect(resolvePriceMethod(undefined, 'Value')).toBeNull()

    const row = validateRow(
      { Cust: 'C100', Value: '0.22' }, 1,
      { kind: 'price_rules', mapping: { customer_external_id: 'Cust', value: 'Value' } },
    )
    expect(row.isValid).toBe(false)
    expect(row.errors.join(' ')).toMatch(/discount, a multiplier or a net price/)
  })

  it('flags a percentage that looks like a mislabelled multiplier', () => {
    const row = validateRow(
      { Cust: 'C100', 'Discount %': '0.78' }, 1,
      { kind: 'price_rules', mapping: { customer_external_id: 'Cust', value: 'Discount %' } },
    )
    expect(row.isValid).toBe(true)
    expect(row.warnings.join(' ')).toMatch(/unusually small/)
  })

  it('rejects a rule with nothing to apply to', () => {
    const row = validateRow(
      { 'Discount %': '22' }, 1,
      { kind: 'price_rules', mapping: { value: 'Discount %' } },
    )
    expect(row.isValid).toBe(false)
    expect(row.errors.join(' ')).toMatch(/nothing for the rule to apply to/)
  })

  it('derives scope from the keys present', () => {
    const row = validateRow(
      { Cust: 'C100', SKU: 'A1', 'Net Price': '12.00' }, 1,
      { kind: 'price_rules', mapping: { customer_external_id: 'Cust', sku: 'SKU', value: 'Net Price' } },
    )
    expect(row.normalized).toMatchObject({ scope: 'customer_product', method: 'fixed_price', value: 12 })
  })
})

describe('customer validation', () => {
  it('will not identify a contractor by a personal mail domain', () => {
    const row = validateRow(
      { Name: 'Bob Electric', Email: 'bob@gmail.com' }, 1,
      { kind: 'customers', mapping: { name: 'Name', contact_email: 'Email' } },
    )
    expect(row.normalized?.email_domain).toBeNull()
    expect(row.warnings.join(' ')).toMatch(/personal mail domain/)
  })

  it('derives a company domain from the contact email', () => {
    const row = validateRow(
      { Name: 'Bob Electric', Email: 'bob@bobelectric.com' }, 1,
      { kind: 'customers', mapping: { name: 'Name', contact_email: 'Email' } },
    )
    expect(row.normalized?.email_domain).toBe('bobelectric.com')
  })
})

describe('csv reading', () => {
  it('handles a BOM, blank lines and ragged rows', () => {
    const sheet = parseCsv('﻿SKU,Description\r\nA1,Widget\r\n\r\nA2,Gadget\r\n')
    expect(sheet.headers).toEqual(['SKU', 'Description'])
    expect(sheet.rows).toEqual([
      { SKU: 'A1', Description: 'Widget' },
      { SKU: 'A2', Description: 'Gadget' },
    ])
  })

  it('makes duplicate headers distinct so neither is lost', () => {
    const sheet = parseCsv('Price,Price\n1,2\n')
    expect(sheet.headers).toEqual(['Price', 'Price_2'])
    expect(applyMapping(sheet.rows[0], { list_price: 'Price_2' })).toEqual({ list_price: '2' })
  })
})

describe('import diff', () => {
  const mapping = { sku: 'SKU', description: 'Description', list_price: 'List', uom: 'UOM' }

  function existingMap(rows: (ExistingRow & { sku: string })[]) {
    const map = new Map<string, ExistingRow>()
    for (const row of rows) map.set(naturalKey('products', row)!, row)
    return map
  }

  it('separates creates, updates and unchanged rows', () => {
    const validated = validateSheet(
      [
        { SKU: 'A1', Description: 'Widget', List: '10.00', UOM: 'EA' },
        { SKU: 'A2', Description: 'Gadget', List: '25.00', UOM: 'EA' },
      ],
      { kind: 'products', mapping },
    )

    const result = diffImport(validated, {
      kind: 'products',
      existing: existingMap([
        { id: 'p1', sku: 'A1', description: 'Widget', list_price: '10.0000', uom: 'EA', is_stocked: true },
      ]),
      deactivateMissing: false,
    })

    expect(result.summary.unchanged).toBe(1)
    expect(result.summary.created).toBe(1)
    expect(result.summary.updated).toBe(0)
  })

  it('does not call a numeric string a change', () => {
    const validated = validateSheet(
      [{ SKU: 'A1', Description: 'Widget', List: '10', UOM: 'EA' }],
      { kind: 'products', mapping },
    )
    const result = diffImport(validated, {
      kind: 'products',
      existing: existingMap([{ id: 'p1', sku: 'A1', description: 'Widget', list_price: '10.0000', uom: 'EA', is_stocked: true }]),
      deactivateMissing: false,
    })
    expect(result.summary.unchanged).toBe(1)
  })

  it('counts and calls out large price moves', () => {
    const validated = validateSheet(
      [{ SKU: 'A1', Description: 'Widget', List: '25.00', UOM: 'EA' }],
      { kind: 'products', mapping },
    )
    const result = diffImport(validated, {
      kind: 'products',
      existing: existingMap([{ id: 'p1', sku: 'A1', description: 'Widget', list_price: '10.0000', uom: 'EA', is_stocked: true }]),
      deactivateMissing: false,
    })
    expect(result.summary.updated).toBe(1)
    expect(result.summary.price_changes).toBe(1)
    expect(result.warnings.some((w) => /move price/.test(w.message))).toBe(true)
  })

  it('blocks a partial export that would deactivate most of the catalogue', () => {
    const validated = validateSheet(
      [{ SKU: 'A1', Description: 'Widget', List: '10', UOM: 'EA' }],
      { kind: 'products', mapping },
    )
    const existing = existingMap([
      { id: 'p1', sku: 'A1', description: 'Widget', list_price: '10', uom: 'EA', is_stocked: true },
      { id: 'p2', sku: 'A2', description: 'Gadget', list_price: '1', uom: 'EA', is_stocked: true },
      { id: 'p3', sku: 'A3', description: 'Doodad', list_price: '1', uom: 'EA', is_stocked: true },
    ])

    const blocking = diffImport(validated, { kind: 'products', existing, deactivateMissing: true })
    expect(blocking.missingIds.sort()).toEqual(['p2', 'p3'])
    expect(blocking.summary.deactivated).toBe(2)
    expect(blocking.warnings.some((w) => w.severity === 'block')).toBe(true)

    // Same file, not deactivating: worth saying, not worth stopping.
    const warning = diffImport(validated, { kind: 'products', existing, deactivateMissing: false })
    expect(warning.summary.deactivated).toBe(0)
    expect(warning.warnings.some((w) => w.severity === 'block')).toBe(false)
  })

  it('never turns an invalid row into a write', () => {
    const validated = validateSheet(
      [{ SKU: '', Description: '', List: 'oops', UOM: '' }],
      { kind: 'products', mapping },
    )
    const result = diffImport(validated, { kind: 'products', existing: new Map(), deactivateMissing: false })
    expect(result.rows[0].action).toBe('skip')
    expect(result.summary.created).toBe(0)
  })
})
