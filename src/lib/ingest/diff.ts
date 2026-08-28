import type { ImportKind } from '@/lib/db/types'
import type { ValidatedRow } from './validate'

/**
 * Diff a validated import against what is already committed, so nobody presses
 * "commit" without seeing what it does. A monthly catalogue export that has
 * quietly lost half its rows, or moved every price 30%, should be obvious here
 * and stoppable (PRD s8: validation, preview and diff before commit).
 */

export type DiffAction = 'create' | 'update' | 'unchanged' | 'skip'

export type FieldChange = { from: unknown; to: unknown }

export type RowDiff = {
  rowNumber: number
  action: DiffAction
  targetId: string | null
  fields: Record<string, FieldChange>
}

export type DiffSummary = {
  created: number
  updated: number
  unchanged: number
  deactivated: number
  price_changes: number
}

export type DiffWarning = { severity: 'warn' | 'block'; message: string }

export type DiffResult = {
  rows: RowDiff[]
  summary: DiffSummary
  /** Rows present in the catalogue but absent from this file. */
  missingIds: string[]
  warnings: DiffWarning[]
}

/** Existing row, reduced to the fields an import can touch. */
export type ExistingRow = { id: string } & Record<string, unknown>

/** The natural key each kind matches on. */
export function naturalKey(kind: ImportKind, row: Record<string, unknown>): string | null {
  switch (kind) {
    case 'products':
      return row.sku ? String(row.sku).trim().toUpperCase() : null
    case 'customers':
      return row.external_id
        ? String(row.external_id).trim().toUpperCase()
        : row.name
          ? `NAME:${String(row.name).trim().toUpperCase()}`
          : null
    case 'substitutions':
      return row.requested_part_number && row.substitute_sku
        ? [row.requested_manufacturer ?? '', row.requested_part_number, row.substitute_sku]
            .join('|').toUpperCase()
        : null
    case 'price_rules':
      return [
        row.scope ?? '', row.customer_external_id ?? row.customer_name ?? '',
        row.sku ?? '', row.category ?? '', row.contract_code ?? '', row.job_name ?? '',
      ].join('|').toUpperCase()
  }
}

/** Fields compared for change. Anything not listed is import metadata. */
const COMPARED: Record<ImportKind, string[]> = {
  products: [
    'description', 'manufacturer', 'manufacturer_part_number', 'upc', 'category',
    'list_price', 'cost', 'uom', 'base_uom', 'units_per_package', 'on_hand_qty',
    'lead_time_days', 'is_stocked',
  ],
  customers: ['name', 'contact_name', 'contact_email', 'phone', 'billing_address', 'email_domain'],
  price_rules: ['method', 'value', 'effective_from', 'effective_to'],
  substitutions: ['relationship', 'notes'],
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || a === undefined) return b === null || b === undefined
  if (b === null || b === undefined) return false
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a)
    const nb = Number(b)
    // Numerics come back from Postgres as strings often enough that a string
    // "12.50" and a number 12.5 must not read as a change.
    if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) < 1e-6
  }
  return String(a) === String(b)
}

export type DiffOptions = {
  kind: ImportKind
  /** Committed rows, keyed by `naturalKey`. */
  existing: Map<string, ExistingRow>
  deactivateMissing: boolean
  /** Fraction of rows that may disappear before the import is blocked. */
  maxMissingFraction?: number
  /** Fraction a price may move before the row is called out. */
  priceMoveThreshold?: number
}

export function diffImport(rows: ValidatedRow[], options: DiffOptions): DiffResult {
  const {
    kind, existing, deactivateMissing,
    maxMissingFraction = 0.2,
    priceMoveThreshold = 0.25,
  } = options

  const compared = COMPARED[kind]
  const out: RowDiff[] = []
  const summary: DiffSummary = { created: 0, updated: 0, unchanged: 0, deactivated: 0, price_changes: 0 }
  const seen = new Set<string>()
  const warnings: DiffWarning[] = []
  let bigPriceMoves = 0

  for (const row of rows) {
    if (!row.isValid || !row.normalized) {
      out.push({ rowNumber: row.rowNumber, action: 'skip', targetId: null, fields: {} })
      continue
    }

    const key = naturalKey(kind, row.normalized)
    if (!key) {
      out.push({ rowNumber: row.rowNumber, action: 'skip', targetId: null, fields: {} })
      continue
    }
    seen.add(key)

    const current = existing.get(key)
    if (!current) {
      out.push({ rowNumber: row.rowNumber, action: 'create', targetId: null, fields: {} })
      summary.created += 1
      continue
    }

    const fields: Record<string, FieldChange> = {}
    for (const field of compared) {
      const to = row.normalized[field] ?? null
      const from = current[field] ?? null
      if (!sameValue(from, to)) fields[field] = { from, to }
    }

    if (Object.keys(fields).length === 0) {
      out.push({ rowNumber: row.rowNumber, action: 'unchanged', targetId: current.id, fields: {} })
      summary.unchanged += 1
      continue
    }

    if ('list_price' in fields || 'value' in fields) {
      summary.price_changes += 1
      const change = fields.list_price ?? fields.value
      const from = Number(change.from)
      const to = Number(change.to)
      if (Number.isFinite(from) && from !== 0 && Number.isFinite(to)) {
        if (Math.abs(to - from) / Math.abs(from) > priceMoveThreshold) bigPriceMoves += 1
      }
    }

    out.push({ rowNumber: row.rowNumber, action: 'update', targetId: current.id, fields })
    summary.updated += 1
  }

  const missingIds: string[] = []
  for (const [key, row] of existing) {
    if (!seen.has(key)) missingIds.push(row.id)
  }
  if (deactivateMissing) summary.deactivated = missingIds.length

  // Guard rails on the shape of the import as a whole.
  if (existing.size > 0) {
    const missingFraction = missingIds.length / existing.size
    if (missingFraction > maxMissingFraction) {
      warnings.push({
        severity: deactivateMissing ? 'block' : 'warn',
        message:
          `${missingIds.length} of ${existing.size} existing rows (${Math.round(missingFraction * 100)}%) ` +
          `are not in this file. A partial export is the usual cause -- check the file covers the whole catalogue.`,
      })
    }
  }

  if (bigPriceMoves > 0) {
    warnings.push({
      severity: 'warn',
      message:
        `${bigPriceMoves} row${bigPriceMoves === 1 ? '' : 's'} move price by more than ` +
        `${Math.round(priceMoveThreshold * 100)}%. Review these before committing.`,
    })
  }

  const skipped = out.filter((r) => r.action === 'skip').length
  if (skipped > 0 && rows.length > 0 && skipped / rows.length > 0.1) {
    warnings.push({
      severity: 'warn',
      message: `${skipped} of ${rows.length} rows could not be read and would be left out. Check the column mapping.`,
    })
  }

  return { rows: out, summary, missingIds, warnings }
}

export function isBlocked(result: DiffResult): boolean {
  return result.warnings.some((w) => w.severity === 'block')
}
