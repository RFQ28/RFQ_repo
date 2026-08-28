import { describe, expect, it } from 'vitest'
import { extractFromRows, extractFromText, parseLine } from '@/lib/parse/lines'

describe('parseLine', () => {
  it('reads a leading quantity and unit', () => {
    const line = parseLine('500ft of 12/2 MC cable', 1)
    expect(line).toMatchObject({
      quantity: 500,
      uomAsWritten: 'ft',
      description: '12/2 MC cable',
      isParsed: true,
    })
  })

  it('reads a trailing quantity', () => {
    const line = parseLine('1/2in EMT set screw connector .... 25 ea', 1)
    expect(line.quantity).toBe(25)
    expect(line.uomAsWritten).toBe('ea')
    expect(line.description).toBe('1/2in EMT set screw connector')
  })

  it('reads a quantity in parentheses', () => {
    expect(parseLine('(6) 4-square boxes', 1)).toMatchObject({ quantity: 6, description: '4-square boxes' })
  })

  it('reads thousands separators', () => {
    expect(parseLine('2,500 LF 3/4 EMT', 1)).toMatchObject({ quantity: 2500, uomAsWritten: 'LF' })
  })

  it('does not mistake a list marker for a quantity', () => {
    const line = parseLine('1. 500ft of 12/2 romex', 1)
    expect(line.quantity).toBe(500)
    expect(line.description).toBe('12/2 romex')
  })

  it('keeps a line with no quantity rather than inventing one', () => {
    const line = parseLine('Square D QO breakers, assorted', 1)
    expect(line.isParsed).toBe(true)
    expect(line.quantity).toBeNull()
    expect(line.description).toBe('Square D QO breakers, assorted')
  })

  it('preserves the raw text exactly', () => {
    const raw = '  12   EA   1/2in  EMT '
    expect(parseLine(raw, 1).rawText).toBe(raw)
  })

  it('picks up the manufacturer', () => {
    expect(parseLine('10 ea Square D QO120 breaker', 1).manufacturer).toBe('square d')
    expect(parseLine('4 Cutler Hammer BR230', 1).manufacturer).toBe('cutler hammer')
  })

  it('prefers the longer manufacturer name', () => {
    expect(parseLine('2 GE Lighting LED lamp', 1).manufacturer).toBe('ge lighting')
  })

  it('picks up a part number', () => {
    expect(parseLine('10 ea Square D QO120 breaker', 1).partNumber).toBe('QO120')
    expect(parseLine('25 Hubbell HBL5261 receptacle', 1).partNumber).toBe('HBL5261')
  })

  it('does not read a wire size as a part number', () => {
    expect(parseLine('500ft 12/2 MC', 1).partNumber).toBeNull()
    expect(parseLine('200 ft 500MCM copper', 1).partNumber).toBeNull()
  })

  it('does not read a conduit type as a part number', () => {
    expect(parseLine('100 ft 3/4 EMT conduit', 1).partNumber).toBeNull()
  })
})

describe('extractFromText', () => {
  const email = `
Hi Dave,

Job: Riverside Medical Phase 2
Need by: 3/14/2026

Please quote the following:

1. 500ft of 12/2 MC cable
2. 25 ea 1/2in EMT set screw connectors
3. (6) Square D QO120 breakers
4. 2,500 LF 3/4 EMT

Thanks,
Mike
Sent from my iPhone
`

  it('pulls out the line items and leaves the chatter behind', () => {
    const { lines } = extractFromText(email)
    expect(lines).toHaveLength(4)
    expect(lines.map((l) => l.quantity)).toEqual([500, 25, 6, 2500])
    expect(lines.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4])
  })

  it('pulls out RFQ-level metadata', () => {
    const { metadata } = extractFromText(email)
    expect(metadata.jobName).toBe('Riverside Medical Phase 2')
    expect(metadata.dueDate).toBe('3/14/2026')
  })

  it('drops greetings, signatures and mail-client footers', () => {
    const { lines } = extractFromText(email)
    const text = lines.map((l) => l.rawText).join(' ')
    expect(text).not.toMatch(/Hi Dave|Thanks|iPhone/)
  })

  it('keeps an unreadable line instead of dropping it', () => {
    const { lines } = extractFromText('500ft 12/2 MC\n???  48\n25 ea connectors')
    expect(lines).toHaveLength(3)
    const unparsed = lines.find((l) => !l.isParsed)
    expect(unparsed?.rawText).toBe('???  48')
    expect(unparsed?.parseError).toBeTruthy()
  })

  it('numbers lines in the order they were written', () => {
    const { lines } = extractFromText('10 ea widgets\n5 ea gadgets\n2 ea doodads')
    expect(lines.map((l) => [l.lineNumber, l.quantity])).toEqual([[1, 10], [2, 5], [3, 2]])
  })

  it('ignores a pasted table header row', () => {
    const { lines } = extractFromText('Qty | Description | UOM\n500 | 12/2 MC | ft')
    expect(lines).toHaveLength(1)
    expect(lines[0].quantity).toBe(500)
  })
})

describe('extractFromRows', () => {
  const headers = ['Qty', 'Description', 'UOM', 'Mfg Part #']

  it('uses the columns when they are labelled', () => {
    const { lines } = extractFromRows(headers, [
      { Qty: '500', Description: '12/2 MC cable', UOM: 'FT', 'Mfg Part #': '' },
      { Qty: '6', Description: 'QO breaker 20A', UOM: 'EA', 'Mfg Part #': 'QO120' },
    ])

    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ quantity: 500, description: '12/2 MC cable', uomAsWritten: 'FT' })
    expect(lines[1]).toMatchObject({ quantity: 6, partNumber: 'QO120' })
  })

  it('strips units out of a quantity cell', () => {
    const { lines } = extractFromRows(headers, [
      { Qty: '1,200 ft', Description: 'THHN #12', UOM: '', 'Mfg Part #': '' },
    ])
    expect(lines[0].quantity).toBe(1200)
  })

  it('keeps a row with no description as unparsed', () => {
    const { lines } = extractFromRows(headers, [
      { Qty: '10', Description: '', UOM: 'EA', 'Mfg Part #': '' },
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0].isParsed).toBe(false)
    expect(lines[0].quantity).toBe(10)
  })

  it('falls back to reading the whole row when nothing is labelled', () => {
    const { lines } = extractFromRows(['A', 'B'], [
      { A: '500ft', B: '12/2 MC cable' },
    ])
    expect(lines[0]).toMatchObject({ quantity: 500, description: '12/2 MC cable' })
  })

  it('skips a header row that survived into the data', () => {
    const { lines } = extractFromRows(headers, [
      { Qty: 'Qty', Description: 'Description', UOM: 'UOM', 'Mfg Part #': 'Part' },
      { Qty: '6', Description: 'QO breaker', UOM: 'EA', 'Mfg Part #': '' },
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0].quantity).toBe(6)
  })
})
