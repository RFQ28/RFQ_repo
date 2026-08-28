import type { ImportKind } from '@/lib/db/types'

/**
 * Column mapping.
 *
 * Every distributor's export names its columns differently and none of them
 * will rename anything for us. We guess, show the guess in the preview, and let
 * the admin correct it; the corrected mapping is stored on the tenant so the
 * next monthly export maps itself.
 */

export type FieldSpec = {
  field: string
  label: string
  required: boolean
  /** Lower-cased header candidates, matched exactly first then loosely. */
  aliases: string[]
  hint?: string
}

const PRODUCT_FIELDS: FieldSpec[] = [
  { field: 'sku', label: 'SKU', required: true,
    aliases: ['sku', 'item', 'item number', 'item no', 'item #', 'product code', 'part', 'stock code', 'itemid', 'product id'] },
  { field: 'description', label: 'Description', required: true,
    aliases: ['description', 'desc', 'item description', 'product description', 'long description', 'name'] },
  { field: 'manufacturer', label: 'Manufacturer', required: false,
    aliases: ['manufacturer', 'mfg', 'mfr', 'vendor', 'brand', 'make'] },
  { field: 'manufacturer_part_number', label: 'Mfr part number', required: false,
    aliases: ['mpn', 'mfg part', 'mfr part number', 'manufacturer part number', 'mfg part number', 'mfgpart', 'vendor part', 'catalog number', 'cat no'] },
  { field: 'upc', label: 'UPC', required: false,
    aliases: ['upc', 'upc code', 'gtin', 'ean', 'barcode'] },
  { field: 'category', label: 'Category', required: false,
    aliases: ['category', 'product category', 'class', 'product line', 'group', 'department'] },
  { field: 'list_price', label: 'List price', required: false,
    aliases: ['list price', 'list', 'price', 'unit price', 'sell price', 'retail', 'col 1 price'],
    hint: 'The published price before any customer discount.' },
  { field: 'cost', label: 'Cost', required: false,
    aliases: ['cost', 'unit cost', 'net cost', 'replacement cost', 'avg cost', 'average cost'] },
  { field: 'uom', label: 'Selling UOM', required: false,
    aliases: ['uom', 'unit', 'unit of measure', 'sell uom', 'selling unit', 'um', 'pricing uom'] },
  { field: 'units_per_package', label: 'Units per package', required: false,
    aliases: ['units per package', 'qty per package', 'package qty', 'pkg qty', 'std pack', 'standard pack', 'qty per uom', 'conversion factor'],
    hint: 'How many base units one sellable package holds -- 250 for a 250ft roll.' },
  { field: 'base_uom', label: 'Base UOM', required: false,
    aliases: ['base uom', 'base unit', 'stocking uom', 'stock uom'] },
  { field: 'on_hand_qty', label: 'On hand', required: false,
    aliases: ['on hand', 'onhand', 'qty on hand', 'quantity on hand', 'available', 'stock', 'qoh', 'inventory'] },
  { field: 'lead_time_days', label: 'Lead time (days)', required: false,
    aliases: ['lead time', 'lead time days', 'leadtime', 'days out'] },
]

const CUSTOMER_FIELDS: FieldSpec[] = [
  { field: 'external_id', label: 'Customer number', required: false,
    aliases: ['customer number', 'customer no', 'customer id', 'cust no', 'account', 'account number', 'acct'] },
  { field: 'name', label: 'Customer name', required: true,
    aliases: ['customer', 'customer name', 'name', 'company', 'company name', 'account name'] },
  { field: 'contact_name', label: 'Contact', required: false,
    aliases: ['contact', 'contact name', 'buyer', 'attn'] },
  { field: 'contact_email', label: 'Email', required: false,
    aliases: ['email', 'e-mail', 'contact email', 'email address'] },
  { field: 'email_domain', label: 'Email domain', required: false,
    aliases: ['domain', 'email domain', 'company domain'],
    hint: 'Used to recognise which contractor sent an RFQ.' },
  { field: 'phone', label: 'Phone', required: false, aliases: ['phone', 'telephone', 'phone number'] },
  { field: 'billing_address', label: 'Address', required: false,
    aliases: ['address', 'billing address', 'bill to', 'street'] },
]

const PRICE_RULE_FIELDS: FieldSpec[] = [
  { field: 'customer_external_id', label: 'Customer number', required: false,
    aliases: ['customer number', 'customer no', 'customer id', 'cust no', 'account', 'account number'] },
  { field: 'customer_name', label: 'Customer name', required: false,
    aliases: ['customer', 'customer name', 'account name'] },
  { field: 'sku', label: 'SKU', required: false,
    aliases: ['sku', 'item', 'item number', 'product code', 'part'] },
  { field: 'category', label: 'Category', required: false,
    aliases: ['category', 'product category', 'class', 'price class', 'product line', 'group'] },
  { field: 'contract_code', label: 'Contract', required: false,
    aliases: ['contract', 'contract code', 'contract number', 'sps', 'special price agreement'] },
  { field: 'job_name', label: 'Job', required: false,
    aliases: ['job', 'job name', 'project', 'job number'] },
  { field: 'method', label: 'Rule type', required: false,
    aliases: ['type', 'rule type', 'price type', 'method', 'basis'],
    hint: 'discount / multiplier / fixed / cost-plus. Inferred from the value column when absent.' },
  { field: 'value', label: 'Value', required: true,
    aliases: ['discount', 'discount %', 'discount percent', 'multiplier', 'price', 'net price', 'value', 'rate', 'factor'] },
  { field: 'effective_from', label: 'Effective from', required: false,
    aliases: ['effective', 'effective from', 'start date', 'from date', 'begin'] },
  { field: 'effective_to', label: 'Effective to', required: false,
    aliases: ['expires', 'effective to', 'end date', 'to date', 'expiration'] },
]

const SUBSTITUTION_FIELDS: FieldSpec[] = [
  { field: 'requested_manufacturer', label: 'Requested manufacturer', required: false,
    aliases: ['requested manufacturer', 'from manufacturer', 'competitor', 'competitor mfg', 'oem'] },
  { field: 'requested_part_number', label: 'Requested part number', required: true,
    aliases: ['requested part', 'competitor part', 'from part', 'cross reference', 'xref', 'their part', 'oem part'] },
  { field: 'substitute_sku', label: 'Our SKU', required: true,
    aliases: ['our sku', 'sku', 'replacement sku', 'substitute', 'substitute sku', 'our part', 'item'] },
  { field: 'relationship', label: 'Relationship', required: false,
    aliases: ['relationship', 'type', 'match type'] },
  { field: 'notes', label: 'Notes', required: false, aliases: ['notes', 'note', 'comment'] },
]

export const FIELD_SPECS: Record<ImportKind, FieldSpec[]> = {
  products: PRODUCT_FIELDS,
  customers: CUSTOMER_FIELDS,
  price_rules: PRICE_RULE_FIELDS,
  substitutions: SUBSTITUTION_FIELDS,
}

function canonical(header: string): string {
  return header
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .replace(/[^a-z0-9% ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type ColumnMapping = Record<string, string>

/**
 * Best-effort header guess. Exact alias matches are taken first across all
 * fields, so a header that is an exact alias of one field is never stolen by
 * another field's fuzzy match.
 */
export function guessMapping(headers: string[], kind: ImportKind): ColumnMapping {
  const specs = FIELD_SPECS[kind]
  const mapping: ColumnMapping = {}
  const taken = new Set<string>()

  const canonicalHeaders = headers.map((h) => ({ header: h, key: canonical(h) }))

  for (const spec of specs) {
    const hit = canonicalHeaders.find(
      ({ header, key }) => !taken.has(header) && spec.aliases.includes(key),
    )
    if (hit) {
      mapping[spec.field] = hit.header
      taken.add(hit.header)
    }
  }

  for (const spec of specs) {
    if (mapping[spec.field]) continue
    const hit = canonicalHeaders.find(
      ({ header, key }) =>
        !taken.has(header) && spec.aliases.some((a) => key.includes(a) || a.includes(key)),
    )
    if (hit) {
      mapping[spec.field] = hit.header
      taken.add(hit.header)
    }
  }

  return mapping
}

export type MappingProblem = { field: string; label: string; message: string }

/** Required fields that the mapping does not cover yet. */
export function missingRequired(mapping: ColumnMapping, kind: ImportKind): MappingProblem[] {
  return FIELD_SPECS[kind]
    .filter((spec) => spec.required && !mapping[spec.field])
    .map((spec) => ({
      field: spec.field,
      label: spec.label,
      message: `No column mapped to ${spec.label}.`,
    }))
}

/** Applies a mapping to one source row, producing field-keyed values. */
export function applyMapping(
  row: Record<string, string>,
  mapping: ColumnMapping,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [field, header] of Object.entries(mapping)) {
    if (!header) continue
    out[field] = (row[header] ?? '').trim()
  }
  return out
}
