import 'server-only'

import type { ImportKind } from '@/lib/db/types'
import { tenantDb, type TenantDb } from '@/lib/supabase/tenant'
import { readTabular } from './tabular'
import { guessMapping, missingRequired, type ColumnMapping } from './mapping'
import { validateSheet, type ValidatedRow } from './validate'
import { diffImport, naturalKey, type DiffResult, type ExistingRow } from './diff'

const CHUNK = 500
const BUCKET = 'catalogue-imports'

export class IngestError extends Error {}

// ---------------------------------------------------------------------------
// Existing state, keyed the same way the diff keys the incoming file
// ---------------------------------------------------------------------------

/**
 * Price rules are keyed by the *source* identifiers (customer number, SKU)
 * rather than by our own uuids, because that is what a re-export carries. The
 * join pulls those back out so the two sides can be compared.
 */
async function loadExisting(db: TenantDb, kind: ImportKind): Promise<Map<string, ExistingRow>> {
  const map = new Map<string, ExistingRow>()

  if (kind === 'products') {
    const { data, error } = await db
      .from('products')
      .select('id, sku, description, manufacturer, manufacturer_part_number, upc, category, list_price, cost, uom, base_uom, units_per_package, on_hand_qty, lead_time_days, is_stocked')
    if (error) throw new IngestError(error.message)
    for (const row of data ?? []) {
      const key = naturalKey('products', row as Record<string, unknown>)
      if (key) map.set(key, row as ExistingRow)
    }
    return map
  }

  if (kind === 'customers') {
    const { data, error } = await db
      .from('customers')
      .select('id, external_id, name, contact_name, contact_email, phone, billing_address')
    if (error) throw new IngestError(error.message)
    for (const row of data ?? []) {
      const key = naturalKey('customers', row as Record<string, unknown>)
      if (key) map.set(key, row as ExistingRow)
    }
    return map
  }

  if (kind === 'substitutions') {
    const { data, error } = await db
      .from('substitution_map')
      .select('id, requested_manufacturer, requested_part_number, relationship, notes, substitute_product_id, products!substitution_map_substitute_product_id_fkey(sku)')
    if (error) throw new IngestError(error.message)
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
      const sku = (row.products as { sku?: string } | null)?.sku
      const key = naturalKey('substitutions', { ...row, substitute_sku: sku })
      if (key) map.set(key, row as ExistingRow)
    }
    return map
  }

  const { data, error } = await db
    .from('price_rules')
    .select('id, scope, method, value, category, contract_code, job_name, effective_from, effective_to, customers(external_id, name), products(sku)')
  if (error) throw new IngestError(error.message)
  for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
    const customer = row.customers as { external_id?: string; name?: string } | null
    const product = row.products as { sku?: string } | null
    const key = naturalKey('price_rules', {
      ...row,
      customer_external_id: customer?.external_id ?? null,
      customer_name: customer?.name ?? null,
      sku: product?.sku ?? null,
    })
    if (key) map.set(key, row as ExistingRow)
  }
  return map
}

// ---------------------------------------------------------------------------
// Stage: read the file, validate every row, diff, and park it all for review
// ---------------------------------------------------------------------------

export type StageResult = {
  importId: string
  mapping: ColumnMapping
  headers: string[]
  rowCount: number
  validCount: number
  errorCount: number
  warningCount: number
  diff: DiffResult
  missingRequiredFields: ReturnType<typeof missingRequired>
}

async function stage(
  db: TenantDb,
  importId: string,
  kind: ImportKind,
  file: { name: string; buffer: ArrayBuffer },
  mappingOverride: ColumnMapping | null,
  deactivateMissing: boolean,
): Promise<StageResult> {
  const sheet = await readTabular(file)
  if (sheet.headers.length === 0) {
    throw new IngestError('That file has no readable header row.')
  }

  const mapping = mappingOverride ?? guessMapping(sheet.headers, kind)
  const missing = missingRequired(mapping, kind)

  // Validate regardless: showing which columns are unmapped alongside the rows
  // they would have filled is more useful than an error on its own.
  const validated: ValidatedRow[] = validateSheet(sheet.rows, { kind, mapping })
  const existing = await loadExisting(db, kind)
  const diff = diffImport(validated, { kind, existing, deactivateMissing })

  // Replace any previous staging for this import (a re-map re-stages).
  const { error: clearError } = await db.from('catalogue_import_rows').delete().eq('import_id', importId)
  if (clearError) throw new IngestError(clearError.message)

  for (let i = 0; i < validated.length; i += CHUNK) {
    const slice = validated.slice(i, i + CHUNK)
    const payload = slice.map((row) => {
      const rowDiff = diff.rows.find((d) => d.rowNumber === row.rowNumber)
      return {
        import_id: importId,
        row_number: row.rowNumber,
        raw: row.raw,
        normalized: row.normalized,
        is_valid: row.isValid,
        errors: row.errors,
        warnings: row.warnings,
        diff_action: rowDiff?.action ?? 'skip',
        diff_fields: rowDiff?.fields ?? {},
        target_id: rowDiff?.targetId ?? null,
      }
    })
    const { error } = await db.from('catalogue_import_rows').insert(payload)
    if (error) throw new IngestError(error.message)
  }

  const validCount = validated.filter((r) => r.isValid).length
  const warningCount = validated.filter((r) => r.warnings.length > 0).length

  const { error: updateError } = await db
    .from('catalogue_imports')
    .update({
      status: 'previewed',
      column_mapping: mapping,
      row_count: validated.length,
      valid_count: validCount,
      error_count: validated.length - validCount,
      warning_count: warningCount,
      diff_summary: diff.summary,
      deactivate_missing: deactivateMissing,
      error: null,
    })
    .eq('id', importId)
  if (updateError) throw new IngestError(updateError.message)

  return {
    importId,
    mapping,
    headers: sheet.headers,
    rowCount: validated.length,
    validCount,
    errorCount: validated.length - validCount,
    warningCount,
    diff,
    missingRequiredFields: missing,
  }
}

export async function createImport(params: {
  tenantId: string
  kind: ImportKind
  file: { name: string; buffer: ArrayBuffer; contentType?: string }
  uploadedBy: string
  deactivateMissing?: boolean
}): Promise<StageResult> {
  const db = tenantDb(params.tenantId)

  const { data: created, error } = await db
    .from('catalogue_imports')
    .insert({
      kind: params.kind,
      filename: params.file.name,
      storage_path: 'pending',
      content_type: params.file.contentType ?? null,
      size_bytes: params.file.buffer.byteLength,
      uploaded_by: params.uploadedBy,
      deactivate_missing: params.deactivateMissing ?? false,
    })
    .select('id')
    .single()

  if (error || !created) throw new IngestError(error?.message ?? 'Could not start the import')

  // The original file is kept whatever happens next, so a bad import can be
  // looked at afterwards rather than guessed about.
  const storagePath = db.path('imports', created.id, params.file.name)
  const upload = await db.storage
    .from(BUCKET)
    .upload(storagePath, params.file.buffer, {
      contentType: params.file.contentType ?? 'application/octet-stream',
      upsert: true,
    })
  if (upload.error) throw new IngestError(`Could not store the file: ${upload.error.message}`)

  await db.from('catalogue_imports').update({ storage_path: storagePath, status: 'validating' }).eq('id', created.id)

  try {
    const result = await stage(db, created.id, params.kind, params.file, null, params.deactivateMissing ?? false)
    await db.log({
      action: 'catalogue_import.staged',
      entityType: 'catalogue_import',
      entityId: created.id,
      actorId: params.uploadedBy,
      detail: { kind: params.kind, filename: params.file.name, ...result.diff.summary },
    })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db.from('catalogue_imports').update({ status: 'failed', error: message }).eq('id', created.id)
    throw error
  }
}

/** Re-run staging with a mapping the admin corrected by hand. */
export async function restageImport(params: {
  tenantId: string
  importId: string
  mapping: ColumnMapping
  deactivateMissing: boolean
}): Promise<StageResult> {
  const db = tenantDb(params.tenantId)

  const { data: record, error } = await db
    .from('catalogue_imports')
    .select('id, kind, filename, storage_path, status')
    .eq('id', params.importId)
    .single()
  if (error || !record) throw new IngestError('Import not found')
  if (record.status === 'committed') throw new IngestError('That import has already been committed')

  const download = await db.storage.from(BUCKET).download(record.storage_path)
  if (download.error || !download.data) {
    throw new IngestError(`Could not read the stored file: ${download.error?.message}`)
  }

  return stage(
    db,
    record.id,
    record.kind,
    { name: record.filename, buffer: await download.data.arrayBuffer() },
    params.mapping,
    params.deactivateMissing,
  )
}

export async function discardImport(tenantId: string, importId: string, userId: string) {
  const db = tenantDb(tenantId)
  const { error } = await db
    .from('catalogue_imports')
    .update({ status: 'discarded' })
    .eq('id', importId)
    .neq('status', 'committed')
  if (error) throw new IngestError(error.message)
  await db.log({
    action: 'catalogue_import.discarded',
    entityType: 'catalogue_import',
    entityId: importId,
    actorId: userId,
  })
}
