import 'server-only'

import type { JobRow, TenantSettings } from '@/lib/db/types'
import { tenantDb } from '@/lib/supabase/tenant'
import { adminClient } from '@/lib/supabase/admin'
import { buildDraftLines, totalDraft, type DraftInputLine } from '@/lib/quote/draft'
import { cataloguePorts } from '@/lib/quote/catalogue'
import { buildUomTables } from '@/lib/quote/uom'
import { DEFAULT_THRESHOLDS } from '@/lib/quote/matching'
import { enqueue } from '../queue'

/**
 * Match, price and draft one RFQ (PRD phases 3-4).
 *
 * Idempotent: re-running it replaces the draft's lines rather than appending,
 * because a retried job must not double a quote. The quote row itself is kept
 * so its number and any rep edits to quote-level fields survive.
 */
export async function matchRfq(job: JobRow): Promise<void> {
  const rfqId = (job.payload as { rfqId?: string })?.rfqId ?? job.rfq_id
  if (!rfqId) throw new Error('match_rfq job has no rfqId')
  if (!job.tenant_id) throw new Error('match_rfq job has no tenant')

  const db = tenantDb(job.tenant_id)

  const { data: rfq, error: rfqError } = await db
    .from('rfqs')
    .select('id, customer_id, job_name, status')
    .eq('id', rfqId)
    .single()
  if (rfqError || !rfq) throw new Error(`RFQ ${rfqId} not found`)

  await db.from('rfqs').update({ status: 'matching' }).eq('id', rfqId)

  const { data: rfqLines, error: linesError } = await db
    .from('rfq_lines')
    .select('id, line_number, raw_text, description, quantity, uom_as_written, manufacturer, part_number, is_parsed')
    .eq('rfq_id', rfqId)
    .order('line_number', { ascending: true })
  if (linesError) throw new Error(linesError.message)

  const lines: DraftInputLine[] = (rfqLines ?? []).map((row) => ({
    id: row.id,
    lineNumber: row.line_number,
    rawText: row.raw_text,
    description: row.description,
    quantity: row.quantity === null ? null : Number(row.quantity),
    uomAsWritten: row.uom_as_written,
    manufacturer: row.manufacturer,
    partNumber: row.part_number,
    isParsed: row.is_parsed,
  }))

  const [{ data: tenant }, { data: aliases }, { data: conversions }] = await Promise.all([
    adminClient().from('tenants').select('settings, quote_validity_days, terms:quote_terms').eq('id', job.tenant_id).single(),
    db.from('uom_aliases').select('alias, uom'),
    db.from('uom_conversions').select('from_uom, to_uom, factor'),
  ])

  const settings = (tenant?.settings ?? null) as TenantSettings | null

  const ports = cataloguePorts(db, { customerId: rfq.customer_id })

  const draft = await buildDraftLines(lines, ports, {
    customerId: rfq.customer_id,
    jobName: rfq.job_name,
    thresholds: settings?.confidence ?? DEFAULT_THRESHOLDS,
    uom: buildUomTables(
      (aliases ?? []).map((a) => ({ alias: a.alias, uom: a.uom })),
      (conversions ?? []).map((c) => ({ from_uom: c.from_uom, to_uom: c.to_uom, factor: Number(c.factor) })),
    ),
  })

  const totals = totalDraft(draft)

  // One draft quote per RFQ. Re-running replaces its lines.
  const { data: existing } = await db
    .from('quotes')
    .select('id, quote_number, status')
    .eq('rfq_id', rfqId)
    .maybeSingle()

  if (existing && existing.status !== 'draft' && existing.status !== 'in_review') {
    // A sent quote is not overwritten by a retried job.
    throw new Error(`Quote for RFQ ${rfqId} is already ${existing.status}; refusing to rewrite it`)
  }

  // The status check above deliberately lets `in_review` through — but that is
  // precisely the state a quote sits in while a rep is working it, and the
  // rewrite below deletes every line. A job retried after a partial failure
  // would silently destroy their corrections, their manual lines and their
  // accepted flags.
  //
  // So the real question is not the status, it is whether anyone has touched
  // the lines. If they have, the job's purpose is already met: a draft exists,
  // and a better one than this job would produce. It stops, and says so in the
  // audit trail rather than failing — a rep having done their work is not an
  // error, and raising here would dead-letter into a false alarm.
  if (existing) {
    const { count: touched } = await db
      .from('quote_lines')
      .select('id', { count: 'exact', head: true })
      .eq('quote_id', existing.id)
      .or('was_corrected.eq.true,is_manual.eq.true,accepted_at.not.is.null')

    if ((touched ?? 0) > 0) {
      await db.log({
        action: 'rfq.rematch_skipped',
        entityType: 'quote',
        entityId: existing.id,
        rfqId,
        quoteId: existing.id,
        detail: {
          reason: 'a rep has already edited this draft',
          edited_lines: touched,
          job_id: job.id,
        },
      })
      return
    }
  }

  let quoteId = existing?.id ?? null

  if (!quoteId) {
    const { data: quoteNumber } = await db.rpc('next_quote_number' as never, {
      target_tenant: job.tenant_id,
    } as never)

    const validUntil = new Date()
    validUntil.setDate(validUntil.getDate() + (tenant?.quote_validity_days ?? 30))

    const { data: created, error: createError } = await db
      .from('quotes')
      .insert({
        rfq_id: rfqId,
        customer_id: rfq.customer_id,
        quote_number: (quoteNumber as unknown as string) ?? null,
        status: 'draft',
        terms: tenant?.terms ?? null,
        valid_until: validUntil.toISOString().slice(0, 10),
      })
      .select('id')
      .single()

    if (createError || !created) throw new Error(createError?.message ?? 'Could not create the draft quote')
    quoteId = created.id
  }

  await db.from('quote_lines').delete().eq('quote_id', quoteId)

  if (draft.length > 0) {
    const { error: insertError } = await db.from('quote_lines').insert(
      draft.map((line) => ({
        quote_id: quoteId,
        rfq_line_id: line.rfqLineId,
        line_number: line.lineNumber,
        product_id: line.productId,
        match_confidence: line.matchConfidence,
        match_band: line.matchBand,
        match_method: line.matchMethod,
        match_reasoning: line.matchReasoning,
        alternatives: line.alternatives,
        requested_qty: line.requestedQty,
        requested_uom: line.requestedUom,
        quoted_qty: line.quotedQty,
        quoted_uom: line.quotedUom,
        uom_conversion_applied: line.uomConversionApplied,
        uom_conversion_note: line.uomConversionNote,
        uom_unresolved: line.uomUnresolved,
        list_price: line.listPrice,
        unit_price: line.unitPrice,
        price_rule_id: line.priceRuleId,
        price_source: line.priceSource,
        price_missing: line.priceMissing,
        line_margin_percent: line.lineMarginPercent,
        extended_price: line.extendedPrice,
        is_substitution: line.isSubstitution,
        substitution_id: line.substitutionId,
        substituted_for_text: line.substitutedForText,
        on_hand_qty: line.onHandQty,
        stock_shortfall: line.stockShortfall,
        lead_time_days: line.leadTimeDays,
        is_flagged: line.isFlagged,
        flag_reasons: line.flagReasons,
      })),
    )
    if (insertError) throw new Error(insertError.message)
  }

  await db
    .from('quotes')
    .update({ subtotal: totals.subtotal, total: totals.subtotal })
    .eq('id', quoteId)

  await db
    .from('rfqs')
    .update({ status: 'draft_ready', draft_ready_at: new Date().toISOString() })
    .eq('id', rfqId)

  await db.log({
    action: 'rfq.drafted',
    entityType: 'rfq',
    entityId: rfqId,
    rfqId,
    quoteId,
    detail: {
      lines: draft.length,
      flagged: draft.filter((l) => l.isFlagged).length,
      subtotal: totals.subtotal,
      unpriced: totals.unpricedLines,
    },
  })

  // Tell the rep where they already are (6.12).
  await enqueue('send_notification', {
    tenantId: job.tenant_id,
    rfqId,
    payload: { kind: 'draft_ready', rfqId, quoteId },
    dedupeKey: `draft_ready:${quoteId}`,
  })
}
