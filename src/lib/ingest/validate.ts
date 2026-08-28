import type { ImportKind, PriceRuleMethod } from '@/lib/db/types'
import { applyMapping, type ColumnMapping } from './mapping'
import {
  CoercionError, isBlank, isKnownUom, toBoolean, toDate, toInt, toMoney, toNumber, toText, toUom,
} from './coerce'

export type ValidatedRow = {
  rowNumber: number
  raw: Record<string, string>
  normalized: Record<string, unknown> | null
  isValid: boolean
  errors: string[]
  warnings: string[]
}

type Collector = { errors: string[]; warnings: string[] }

/** Runs one coercion, turning a CoercionError into a row error. */
function attempt<T>(collect: Collector, fn: () => T): T | undefined {
  try {
    return fn()
  } catch (error) {
    collect.errors.push(error instanceof CoercionError ? error.message : String(error))
    return undefined
  }
}

// ---------------------------------------------------------------------------
// products
// ---------------------------------------------------------------------------

function validateProduct(fields: Record<string, string>, collect: Collector) {
  const sku = toText(fields.sku)
  const description = toText(fields.description)

  if (!sku) collect.errors.push('SKU is required')
  if (!description) collect.errors.push('Description is required')

  const listPrice = attempt(collect, () => toMoney(fields.list_price, 'List price'))
  const cost = attempt(collect, () => toMoney(fields.cost, 'Cost'))
  const onHand = attempt(collect, () => toNumber(fields.on_hand_qty, 'On hand'))
  const unitsPerPackage = attempt(collect, () => toNumber(fields.units_per_package, 'Units per package'))
  const leadTime = attempt(collect, () => toInt(fields.lead_time_days, 'Lead time'))

  const uom = toUom(fields.uom) ?? 'EA'
  const baseUom = toUom(fields.base_uom)

  if (!isKnownUom(uom)) {
    collect.warnings.push(`Unrecognised unit "${uom}" -- add it to the tenant UOM table before quoting`)
  }
  if (listPrice === undefined) {
    // Not fatal: plenty of catalogue lines are quote-only. But the rep must be
    // told, because the pricing engine will flag every one of these (6.5).
    collect.warnings.push('No list price -- lines matching this product will be flagged as missing price')
  }
  if (listPrice !== undefined && listPrice < 0) {
    collect.errors.push('List price is negative')
  }
  if (unitsPerPackage !== undefined && unitsPerPackage <= 0) {
    collect.errors.push('Units per package must be greater than zero')
  }
  // A package unit with no package size is the 10x-error case from 6.6.
  if (['ROLL', 'BOX', 'CTN', 'COIL', 'SPOOL', 'PKG'].includes(uom) && unitsPerPackage === undefined) {
    collect.warnings.push(
      `Sold by ${uom} but no units-per-package given -- quantity conversion for this product cannot be checked`,
    )
  }

  return {
    sku,
    description,
    manufacturer: toText(fields.manufacturer),
    manufacturer_part_number: toText(fields.manufacturer_part_number),
    upc: toText(fields.upc),
    category: toText(fields.category),
    list_price: listPrice ?? null,
    cost: cost ?? null,
    uom,
    base_uom: baseUom ?? null,
    units_per_package: unitsPerPackage ?? null,
    on_hand_qty: onHand ?? null,
    lead_time_days: leadTime ?? null,
    is_stocked: toBoolean(fields.is_stocked) ?? true,
  }
}

// ---------------------------------------------------------------------------
// customers
// ---------------------------------------------------------------------------

function validateCustomer(fields: Record<string, string>, collect: Collector) {
  const name = toText(fields.name)
  if (!name) collect.errors.push('Customer name is required')

  const email = toText(fields.contact_email)
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    collect.warnings.push(`"${email}" does not look like an email address`)
  }

  let domain = toText(fields.email_domain)?.toLowerCase().replace(/^@/, '')
  if (!domain && email) domain = email.split('@')[1]?.toLowerCase()

  // Free mail domains identify a person, not a company, so matching an RFQ on
  // one would attach every gmail contractor to the same account (6.5).
  const FREE_MAIL = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'comcast.net']
  if (domain && FREE_MAIL.includes(domain)) {
    collect.warnings.push(
      `"${domain}" is a personal mail domain and will not be used to identify this customer -- their address will be matched individually`,
    )
    domain = undefined
  }

  return {
    external_id: toText(fields.external_id) ?? null,
    name,
    contact_name: toText(fields.contact_name) ?? null,
    contact_email: email ?? null,
    email_domain: domain ?? null,
    phone: toText(fields.phone) ?? null,
    billing_address: toText(fields.billing_address) ?? null,
  }
}

// ---------------------------------------------------------------------------
// price rules
// ---------------------------------------------------------------------------

const METHOD_WORDS: [RegExp, PriceRuleMethod][] = [
  [/discount|disc\b|off list|%\s*off/i, 'discount_percent_off_list'],
  // "Col 1"/"Column 3" headers are price columns in the trade data everyone
  // uses, not multipliers, so they are left to fall through to fixed_price.
  [/multiplier|multi\b|factor/i, 'multiplier_on_list'],
  [/net price|net\b|fixed|contract price|sell price|unit price|price/i, 'fixed_price'],
  [/cost\s*\+|cost plus|markup|margin over cost/i, 'cost_plus_percent'],
]

/**
 * Which kind of price rule a row expresses.
 *
 * Read in order: an explicit rule-type column, then the header the value came
 * from. A bare number under a header like "Value" is genuinely ambiguous --
 * 0.22 could be a 22% discount or a 0.22 multiplier, an 80x difference -- so it
 * is rejected rather than guessed (6.5: never quietly guess at a price).
 */
export function resolvePriceMethod(
  explicit: string | undefined,
  valueHeader: string | undefined,
): PriceRuleMethod | null {
  const source = !isBlank(explicit) ? explicit! : (valueHeader ?? '')
  for (const [pattern, method] of METHOD_WORDS) {
    if (pattern.test(source)) return method
  }
  return null
}

function validatePriceRule(
  fields: Record<string, string>,
  collect: Collector,
  valueHeader: string | undefined,
) {
  const method = resolvePriceMethod(fields.method, valueHeader)
  if (!method) {
    collect.errors.push(
      'Cannot tell whether this value is a discount, a multiplier or a net price. ' +
        'Map the "Rule type" column, or rename the value column to say which it is.',
    )
  }

  const value = attempt(collect, () => toNumber(fields.value, 'Value'))
  if (value === undefined && !collect.errors.some((e) => e.startsWith('Value'))) {
    collect.errors.push('Value is required')
  }

  if (value !== undefined && method) {
    if (method === 'discount_percent_off_list') {
      if (value < 0 || value > 100) collect.errors.push(`Discount of ${value}% is out of range`)
      // 0.22 under a "Discount %" header is almost certainly a multiplier
      // mislabelled; quoting it as 0.22% off would be a 78-point error.
      if (value > 0 && value < 1) {
        collect.warnings.push(
          `Discount of ${value}% is unusually small -- check this is a percentage and not a multiplier`,
        )
      }
    }
    if (method === 'multiplier_on_list' && (value <= 0 || value > 2)) {
      collect.warnings.push(`Multiplier of ${value} is outside the usual 0-2 range`)
    }
    if (method === 'fixed_price' && value < 0) {
      collect.errors.push('Net price is negative')
    }
  }

  const customerKey = toText(fields.customer_external_id) ?? toText(fields.customer_name)
  const sku = toText(fields.sku)
  const category = toText(fields.category)
  const contract = toText(fields.contract_code)
  const job = toText(fields.job_name)

  let scope: string | null = null
  if (customerKey && sku) scope = 'customer_product'
  else if (customerKey && category) scope = 'customer_category'
  else if (job) scope = 'job'
  else if (contract) scope = 'contract'
  else if (customerKey) scope = 'customer'

  if (!scope) {
    collect.errors.push(
      'No customer, contract or job on this row -- there is nothing for the rule to apply to',
    )
  }

  return {
    scope,
    method,
    value: value ?? null,
    customer_external_id: toText(fields.customer_external_id) ?? null,
    customer_name: toText(fields.customer_name) ?? null,
    sku: sku ?? null,
    category: category ?? null,
    contract_code: contract ?? null,
    job_name: job ?? null,
    effective_from: attempt(collect, () => toDate(fields.effective_from, 'Effective from')) ?? null,
    effective_to: attempt(collect, () => toDate(fields.effective_to, 'Effective to')) ?? null,
  }
}

// ---------------------------------------------------------------------------
// substitutions
// ---------------------------------------------------------------------------

function validateSubstitution(fields: Record<string, string>, collect: Collector) {
  const requestedPart = toText(fields.requested_part_number)
  const substituteSku = toText(fields.substitute_sku)

  if (!requestedPart) collect.errors.push('Requested part number is required')
  if (!substituteSku) collect.errors.push('Our SKU is required')

  const relationshipRaw = toText(fields.relationship)?.toLowerCase()
  const relationship =
    relationshipRaw && ['equivalent', 'upgrade', 'downgrade', 'accessory'].includes(relationshipRaw)
      ? relationshipRaw
      : 'equivalent'
  if (relationshipRaw && relationship !== relationshipRaw) {
    collect.warnings.push(`Unknown relationship "${relationshipRaw}" -- treated as equivalent`)
  }

  return {
    requested_manufacturer: toText(fields.requested_manufacturer) ?? null,
    requested_part_number: requestedPart,
    substitute_sku: substituteSku,
    relationship,
    notes: toText(fields.notes) ?? null,
  }
}

// ---------------------------------------------------------------------------

export type ValidateOptions = {
  kind: ImportKind
  mapping: ColumnMapping
}

export function validateRow(
  raw: Record<string, string>,
  rowNumber: number,
  { kind, mapping }: ValidateOptions,
): ValidatedRow {
  const fields = applyMapping(raw, mapping)
  const collect: Collector = { errors: [], warnings: [] }

  const allBlank = Object.values(fields).every((v) => isBlank(v))
  if (allBlank) {
    return {
      rowNumber, raw, normalized: null, isValid: false,
      errors: ['Row is empty under the mapped columns'], warnings: [],
    }
  }

  let normalized: Record<string, unknown>
  switch (kind) {
    case 'products':
      normalized = validateProduct(fields, collect)
      break
    case 'customers':
      normalized = validateCustomer(fields, collect)
      break
    case 'price_rules':
      normalized = validatePriceRule(fields, collect, mapping.value)
      break
    case 'substitutions':
      normalized = validateSubstitution(fields, collect)
      break
  }

  return {
    rowNumber,
    raw,
    normalized: collect.errors.length === 0 ? normalized : null,
    isValid: collect.errors.length === 0,
    errors: collect.errors,
    warnings: collect.warnings,
  }
}

/** The column whose value must be unique across the file, if any. */
function uniqueKeyOf(kind: ImportKind, normalized: Record<string, unknown>): string | null {
  switch (kind) {
    case 'products':
      return normalized.sku ? String(normalized.sku).toUpperCase() : null
    case 'customers':
      return normalized.external_id ? String(normalized.external_id).toUpperCase() : null
    case 'substitutions':
      return normalized.requested_part_number && normalized.substitute_sku
        ? `${normalized.requested_manufacturer ?? ''}|${normalized.requested_part_number}|${normalized.substitute_sku}`.toUpperCase()
        : null
    case 'price_rules':
      return null // several rules per customer is the normal shape
  }
}

export function validateSheet(
  rows: Record<string, string>[],
  options: ValidateOptions,
): ValidatedRow[] {
  const validated = rows.map((row, index) => validateRow(row, index + 1, options))

  // A duplicate key inside one file means the later row silently wins on
  // upsert. Surface it at preview instead, where someone can look at both.
  const firstSeen = new Map<string, number>()
  for (const row of validated) {
    if (!row.normalized) continue
    const key = uniqueKeyOf(options.kind, row.normalized)
    if (!key) continue

    const earlier = firstSeen.get(key)
    if (earlier === undefined) {
      firstSeen.set(key, row.rowNumber)
    } else {
      row.errors.push(`Duplicate of row ${earlier} (same key "${key}")`)
      row.isValid = false
      row.normalized = null
    }
  }

  return validated
}
