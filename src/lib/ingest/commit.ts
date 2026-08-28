import 'server-only'

import type { Database, ImportKind, PriceRuleMethod, PriceRuleScope } from '@/lib/db/types'
import { tenantDb, type TenantDb } from '@/lib/supabase/tenant'
import { IngestError } from './service'

const CHUNK = 500

type ProductInsert = Database['public']['Tables']['products']['Insert']

export type CommitResult = {
  created: number
  updated: number
  deactivated: number
  skipped: number
  unresolved: string[]
}

type StagedRow = {
  row_number: number
  normalized: Record<string, unknown>
  diff_action: 'create' | 'update' | 'unchanged' | 'skip' | null
  target_id: string | null
}

async function loadStagedRows(db: TenantDb, importId: string): Promise<StagedRow[]> {
  const rows: StagedRow[] = []
  let from = 0
  // Supabase caps a single response, so a 40k-line catalogue is paged.
  for (;;) {
    const { data, error } = await db
      .from('catalogue_import_rows')
      .select('row_number, normalized, diff_action, target_id')
      .eq('import_id', importId)
      .eq('is_valid', true)
      .order('row_number', { ascending: true })
      .range(from, from + CHUNK - 1)
    if (error) throw new IngestError(error.message)
    const batch = (data ?? []) as unknown as StagedRow[]
    rows.push(...batch)
    if (batch.length < CHUNK) break
    from += CHUNK
  }
  return rows
}

// ---------------------------------------------------------------------------

async function commitProducts(db: TenantDb, importId: string, rows: StagedRow[]): Promise<CommitResult> {
  const result: CommitResult = { created: 0, updated: 0, deactivated: 0, skipped: 0, unresolved: [] }

  const writable = rows.filter((r) => r.diff_action === 'create' || r.diff_action === 'update')
  for (let i = 0; i < writable.length; i += CHUNK) {
    // `normalized` came back from jsonb, so its shape is only known to have
    // survived validateProduct(). That check is the guarantee; the cast just
    // acknowledges the round trip through the database.
    const payload = writable.slice(i, i + CHUNK).map((row) => ({
      ...row.normalized,
      catalogue_import_id: importId,
      is_active: true,
    })) as unknown as ProductInsert[]

    const { error } = await db.from('products').upsert(payload, { onConflict: 'tenant_id,sku' })
    if (error) throw new IngestError(`products: ${error.message}`)
  }

  result.created = rows.filter((r) => r.diff_action === 'create').length
  result.updated = rows.filter((r) => r.diff_action === 'update').length
  result.skipped = rows.filter((r) => r.diff_action === 'unchanged').length
  return result
}

async function commitCustomers(db: TenantDb, importId: string, rows: StagedRow[]): Promise<CommitResult> {
  const result: CommitResult = { created: 0, updated: 0, deactivated: 0, skipped: 0, unresolved: [] }

  for (const row of rows) {
    if (row.diff_action === 'unchanged') {
      result.skipped += 1
      // An unchanged customer can still be missing its identifier row.
      await upsertIdentifier(db, row.target_id, row.normalized)
      continue
    }
    if (row.diff_action !== 'create' && row.diff_action !== 'update') continue

    const { email_domain, ...fields } = row.normalized as Record<string, unknown> & { email_domain?: string | null }

    const { data, error } = row.target_id
      ? await db.from('customers').update(fields as never).eq('id', row.target_id).select('id').single()
      : await db.from('customers').insert(fields as never).select('id').single()

    if (error) throw new IngestError(`customers row ${row.row_number}: ${error.message}`)
    if (row.target_id) result.updated += 1
    else result.created += 1

    await upsertIdentifier(db, data?.id ?? row.target_id, { ...row.normalized, email_domain })
  }

  return result

  async function upsertIdentifier(scoped: TenantDb, customerId: string | null, normalized: Record<string, unknown>) {
    if (!customerId) return
    const domain = normalized.email_domain as string | null
    const email = normalized.contact_email as string | null

    // A confirmed rep decision outranks the export, so identifiers already
    // confirmed by a person are left alone (6.5).
    if (domain) {
      await scoped
        .from('customer_identifiers')
        .upsert({ customer_id: customerId, kind: 'email_domain', value: domain },
          { onConflict: 'tenant_id,kind,value', ignoreDuplicates: true })
    }
    if (email) {
      await scoped
        .from('customer_identifiers')
        .upsert({ customer_id: customerId, kind: 'email_address', value: email.toLowerCase() },
          { onConflict: 'tenant_id,kind,value', ignoreDuplicates: true })
    }
  }
}

async function commitPriceRules(db: TenantDb, importId: string, rows: StagedRow[]): Promise<CommitResult> {
  const result: CommitResult = { created: 0, updated: 0, deactivated: 0, skipped: 0, unresolved: [] }

  const customersByExternal = new Map<string, string>()
  const customersByName = new Map<string, string>()
  const { data: customers } = await db.from('customers').select('id, external_id, name')
  for (const c of customers ?? []) {
    if (c.external_id) customersByExternal.set(c.external_id.toUpperCase(), c.id)
    customersByName.set(c.name.toUpperCase(), c.id)
  }

  const productsBySku = new Map<string, string>()
  const { data: products } = await db.from('products').select('id, sku')
  for (const p of products ?? []) productsBySku.set(p.sku.toUpperCase(), p.id)

  for (const row of rows) {
    if (row.diff_action === 'unchanged') {
      result.skipped += 1
      continue
    }
    if (row.diff_action !== 'create' && row.diff_action !== 'update') continue

    const n = row.normalized as Record<string, string | number | null>
    const customerKey = (n.customer_external_id ?? '') as string
    const customerName = (n.customer_name ?? '') as string

    const customerId =
      (customerKey && customersByExternal.get(customerKey.toUpperCase())) ||
      (customerName && customersByName.get(customerName.toUpperCase())) ||
      null

    const productId = n.sku ? (productsBySku.get(String(n.sku).toUpperCase()) ?? null) : null

    // A rule pointing at a customer or product we have never imported would
    // silently never fire. Report it instead of writing it.
    if ((customerKey || customerName) && !customerId) {
      result.unresolved.push(`Row ${row.row_number}: no customer matching "${customerKey || customerName}"`)
      continue
    }
    if (n.sku && !productId) {
      result.unresolved.push(`Row ${row.row_number}: no product matching SKU "${n.sku}"`)
      continue
    }

    const payload = {
      scope: n.scope as PriceRuleScope,
      method: n.method as PriceRuleMethod,
      value: Number(n.value),
      customer_id: customerId,
      product_id: productId,
      category: (n.category as string | null) ?? null,
      contract_code: (n.contract_code as string | null) ?? null,
      job_name: (n.job_name as string | null) ?? null,
      effective_from: (n.effective_from as string | null) ?? null,
      effective_to: (n.effective_to as string | null) ?? null,
      catalogue_import_id: importId,
    }

    const { error } = row.target_id
      ? await db.from('price_rules').update(payload as never).eq('id', row.target_id)
      : await db.from('price_rules').insert(payload as never)

    if (error) throw new IngestError(`price_rules row ${row.row_number}: ${error.message}`)
    if (row.target_id) result.updated += 1
    else result.created += 1
  }

  return result
}

async function commitSubstitutions(db: TenantDb, importId: string, rows: StagedRow[]): Promise<CommitResult> {
  const result: CommitResult = { created: 0, updated: 0, deactivated: 0, skipped: 0, unresolved: [] }

  const productsBySku = new Map<string, string>()
  const { data: products } = await db.from('products').select('id, sku')
  for (const p of products ?? []) productsBySku.set(p.sku.toUpperCase(), p.id)

  for (const row of rows) {
    if (row.diff_action === 'unchanged') {
      result.skipped += 1
      continue
    }
    if (row.diff_action !== 'create' && row.diff_action !== 'update') continue

    const n = row.normalized as Record<string, string | null>
    const substituteId = n.substitute_sku ? productsBySku.get(n.substitute_sku.toUpperCase()) : null
    if (!substituteId) {
      result.unresolved.push(`Row ${row.row_number}: no product matching SKU "${n.substitute_sku}"`)
      continue
    }

    const payload = {
      requested_manufacturer: n.requested_manufacturer,
      requested_part_number: n.requested_part_number,
      substitute_product_id: substituteId,
      relationship: n.relationship ?? 'equivalent',
      notes: n.notes ?? null,
      source: 'import' as const,
    }

    const { error } = row.target_id
      ? await db.from('substitution_map').update(payload as never).eq('id', row.target_id)
      : await db.from('substitution_map').insert(payload as never)

    if (error) throw new IngestError(`substitutions row ${row.row_number}: ${error.message}`)
    if (row.target_id) result.updated += 1
    else result.created += 1
  }

  return result
}

// ---------------------------------------------------------------------------

/**
 * Applies a previewed import to the live catalogue.
 *
 * Rows that failed validation are never written. Rows the diff called
 * `unchanged` are skipped rather than rewritten, so a monthly re-import does
 * not churn every updated_at in the table.
 */
export async function commitImport(params: {
  tenantId: string
  importId: string
  userId: string
}): Promise<CommitResult> {
  const db = tenantDb(params.tenantId)

  const { data: record, error } = await db
    .from('catalogue_imports')
    .select('id, kind, status, deactivate_missing, filename')
    .eq('id', params.importId)
    .single()
  if (error || !record) throw new IngestError('Import not found')
  if (record.status === 'committed') throw new IngestError('That import has already been committed')
  if (record.status !== 'previewed') {
    throw new IngestError('Only a previewed import can be committed')
  }

  await db.from('catalogue_imports').update({ status: 'committing' }).eq('id', record.id)

  try {
    const rows = await loadStagedRows(db, record.id)
    const kind = record.kind as ImportKind

    let result: CommitResult
    switch (kind) {
      case 'products':
        result = await commitProducts(db, record.id, rows)
        break
      case 'customers':
        result = await commitCustomers(db, record.id, rows)
        break
      case 'price_rules':
        result = await commitPriceRules(db, record.id, rows)
        break
      case 'substitutions':
        result = await commitSubstitutions(db, record.id, rows)
        break
    }

    // Products absent from a full export are deactivated, never deleted --
    // quotes already reference them, and history has to stay readable.
    if (kind === 'products' && record.deactivate_missing) {
      // `neq` alone would skip rows whose catalogue_import_id is null -- in
      // Postgres, null fails an inequality rather than passing it -- and those
      // are exactly the products seeded before the first import.
      const { data: deactivated, error: deactivateError } = await db
        .from('products')
        .update({ is_active: false })
        .eq('is_active', true)
        .or(`catalogue_import_id.is.null,catalogue_import_id.neq.${record.id}`)
        .select('id')
      if (deactivateError) throw new IngestError(deactivateError.message)
      result.deactivated = deactivated?.length ?? 0
    }

    await db
      .from('catalogue_imports')
      .update({ status: 'committed', committed_at: new Date().toISOString(), committed_by: params.userId })
      .eq('id', record.id)

    await db.log({
      action: 'catalogue_import.committed',
      entityType: 'catalogue_import',
      entityId: record.id,
      actorId: params.userId,
      detail: { kind, filename: record.filename, ...result },
    })

    return result
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    await db.from('catalogue_imports').update({ status: 'failed', error: message }).eq('id', record.id)
    await db.log({
      action: 'catalogue_import.failed',
      entityType: 'catalogue_import',
      entityId: record.id,
      actorId: params.userId,
      detail: { error: message },
    })
    throw thrown
  }
}
