/**
 * Value coercion for catalogue imports.
 *
 * Every function returns `undefined` for "absent" and throws `CoercionError`
 * for "present but unreadable". The caller turns the second case into a row
 * error rather than a null, because a price that silently became null is a
 * quote priced wrong (PRD 6.5).
 */

export class CoercionError extends Error {}

const EMPTY = new Set(['', '-', '--', 'n/a', 'na', 'none', 'null', 'tbd'])

export function isBlank(value: string | undefined | null): boolean {
  return value === undefined || value === null || EMPTY.has(value.trim().toLowerCase())
}

export function toText(value: string | undefined): string | undefined {
  if (isBlank(value)) return undefined
  return value!.trim()
}

/** Money as exports write it: "$1,234.56", "1 234,56", "(12.00)" for negative. */
export function toMoney(value: string | undefined, field: string): number | undefined {
  if (isBlank(value)) return undefined
  let raw = value!.trim()

  let negative = false
  if (/^\(.*\)$/.test(raw)) {
    negative = true
    raw = raw.slice(1, -1)
  }
  if (raw.startsWith('-')) {
    negative = true
    raw = raw.slice(1)
  }

  raw = raw.replace(/[$€£\s]/g, '')

  // With both marks present, whichever comes last is the decimal separator:
  // "1,234.56" is US, "1.234,56" is European.
  if (raw.includes(',') && raw.includes('.')) {
    raw = raw.lastIndexOf(',') > raw.lastIndexOf('.')
      ? raw.replace(/\./g, '').replace(',', '.')
      : raw.replace(/,/g, '')
  } else if (raw.includes(',')) {
    // A lone comma is decimal when it sits 1-2 digits from the end
    // ("1234,56"), and a thousands separator otherwise ("1,234").
    const [, tail = ''] = raw.split(',')
    raw = raw.split(',').length === 2 && tail.length <= 2
      ? raw.replace(',', '.')
      : raw.replace(/,/g, '')
  }

  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new CoercionError(`${field}: "${value}" is not a price`)
  }
  return negative ? -n : n
}

export function toNumber(value: string | undefined, field: string): number | undefined {
  if (isBlank(value)) return undefined
  const raw = value!.replace(/[,\s]/g, '')
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new CoercionError(`${field}: "${value}" is not a number`)
  }
  return n
}

export function toInt(value: string | undefined, field: string): number | undefined {
  const n = toNumber(value, field)
  if (n === undefined) return undefined
  if (!Number.isInteger(n)) {
    // Lead times arrive as "5.0" often enough that rounding beats rejecting.
    return Math.round(n)
  }
  return n
}

export function toBoolean(value: string | undefined): boolean | undefined {
  if (isBlank(value)) return undefined
  const v = value!.trim().toLowerCase()
  if (['y', 'yes', 'true', '1', 't', 'stocked', 'active'].includes(v)) return true
  if (['n', 'no', 'false', '0', 'f', 'nonstock', 'non-stock', 'inactive'].includes(v)) return false
  return undefined
}

/** ISO date string, or throws. Accepts ISO, US m/d/y, and Excel serial dates. */
export function toDate(value: string | undefined, field: string): string | undefined {
  if (isBlank(value)) return undefined
  const raw = value!.trim()

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)

  const us = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/)
  if (us) {
    const [, m, d, y] = us
    const year = y.length === 2 ? Number(y) + (Number(y) > 70 ? 1900 : 2000) : Number(y)
    const iso = `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
    if (Number.isNaN(Date.parse(iso))) throw new CoercionError(`${field}: "${value}" is not a date`)
    return iso
  }

  // Excel serial: days since 1899-12-30.
  if (/^\d{5}(\.\d+)?$/.test(raw)) {
    const ms = (Number(raw) - 25569) * 86400 * 1000
    return new Date(ms).toISOString().slice(0, 10)
  }

  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) throw new CoercionError(`${field}: "${value}" is not a date`)
  return new Date(parsed).toISOString().slice(0, 10)
}

/**
 * Canonical unit codes. Anything unrecognised is passed through upper-cased
 * rather than dropped -- an unknown unit is a flag for the rep later (6.6),
 * not something to silently rewrite as "each".
 */
const UOM_CANON: Record<string, string> = {
  ea: 'EA', each: 'EA', pc: 'EA', pcs: 'EA', piece: 'EA', pieces: 'EA', unit: 'EA', un: 'EA',
  ft: 'FT', foot: 'FT', feet: 'FT', lf: 'FT', 'lin ft': 'FT', 'linear foot': 'FT', 'linear feet': 'FT',
  mft: 'MFT', 'm ft': 'MFT', mfeet: 'MFT', 'thousand feet': 'MFT',
  cft: 'CFT', 'c ft': 'CFT', 'hundred feet': 'CFT',
  in: 'IN', inch: 'IN', inches: 'IN',
  yd: 'YD', yard: 'YD', yards: 'YD',
  lb: 'LB', lbs: 'LB', pound: 'LB', pounds: 'LB',
  cwt: 'CWT', hundredweight: 'CWT',
  roll: 'ROLL', rolls: 'ROLL', rl: 'ROLL',
  box: 'BOX', boxes: 'BOX', bx: 'BOX',
  carton: 'CTN', ctn: 'CTN', case: 'CTN', cs: 'CTN',
  coil: 'COIL', coils: 'COIL',
  spool: 'SPOOL', spools: 'SPOOL', reel: 'SPOOL',
  pkg: 'PKG', package: 'PKG', pk: 'PKG',
  doz: 'DOZ', dozen: 'DOZ', dz: 'DOZ',
  c: 'C', hundred: 'C',
  gal: 'GAL', gallon: 'GAL',
  hr: 'HR', hour: 'HR', hrs: 'HR',
}

export function toUom(value: string | undefined): string | undefined {
  if (isBlank(value)) return undefined
  const key = value!.trim().toLowerCase().replace(/[.]/g, '').replace(/\s+/g, ' ')
  return UOM_CANON[key] ?? value!.trim().toUpperCase()
}

export function isKnownUom(uom: string): boolean {
  return Object.values(UOM_CANON).includes(uom)
}
