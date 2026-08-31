'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireSession } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'
import { tenantDb } from '@/lib/supabase/tenant'
import {
  extendedPrice, marginOf, priceFromMargin, priceLine, type ApplicableRule,
} from '@/lib/quote/pricing'
import type { QuoteLineRow, QuoteRow } from '@/lib/db/types'

/**
 * Everything a rep does on the review screen (PRD 6.9, 6.10).
 *
 * Two things hold throughout:
 *
 *   - Every change is written through the user's own session, so RLS applies.
 *     A rep cannot reach another tenant's quote even with a guessed id.
 *   - Every match a rep changes is recorded as a correction (6.8). That is the
 *     learning loop, and it only works if it is wired into the ordinary act of
 *     fixing a line rather than into a separate "teach the system" gesture
 *     nobody would ever use.
 */

export type LineActionState = { error?: string; savedAt?: number }

async function loadLine(quoteLineId: string) {
  const session = await requireSession()
  const supabase = await createClient()

  const { data: line, error } = await supabase
    .from('quote_lines')
    .select('*, quotes(id, rfq_id, customer_id, status)')
    .eq('id', quoteLineId)
    .maybeSingle()

  if (error || !line) throw new Error('That line could not be found')

  const quote = line.quotes as unknown as {
    id: string
    rfq_id: string
    customer_id: string | null
    status: string
  }

  if (quote.status !== 'draft' && quote.status !== 'in_review') {
    throw new Error('This quote has already been sent')
  }

  return { session, supabase, line, quote }
}

// ---------------------------------------------------------------------------
// Claiming (6.10)
// ---------------------------------------------------------------------------

export async function claimRfq(rfqId: string, force = false): Promise<LineActionState> {
  const { user, tenant } = await requireSession()
  const supabase = await createClient()

  const { data: rfq } = await supabase
    .from('rfqs')
    .select('id, claimed_by, claimed_at, users:claimed_by(full_name, email)')
    .eq('id', rfqId)
    .maybeSingle()

  if (!rfq) return { error: 'That RFQ could not be found' }

  if (rfq.claimed_by && rfq.claimed_by !== user.id && !force) {
    const holder = rfq.users as unknown as { full_name: string | null; email: string } | null
    return { error: `${holder?.full_name ?? holder?.email ?? 'Another rep'} has this one open` }
  }

  const { error } = await supabase
    .from('rfqs')
    .update({ claimed_by: user.id, claimed_at: new Date().toISOString(), status: 'in_review' })
    .eq('id', rfqId)

  if (error) return { error: error.message }

  await tenantDb(tenant.id).log({
    action: force ? 'rfq.claim_forced' : 'rfq.claimed',
    entityType: 'rfq',
    entityId: rfqId,
    rfqId,
    actorId: user.id,
  })

  revalidatePath(`/quotes`)
  return { savedAt: Date.now() }
}

export async function releaseRfq(rfqId: string): Promise<LineActionState> {
  const { user } = await requireSession()
  const supabase = await createClient()

  const { error } = await supabase
    .from('rfqs')
    .update({ claimed_by: null, claimed_at: null, status: 'draft_ready' })
    .eq('id', rfqId)
    .eq('claimed_by', user.id)

  return error ? { error: error.message } : { savedAt: Date.now() }
}

// ---------------------------------------------------------------------------
// Line edits
// ---------------------------------------------------------------------------

const LineEdit = z.object({
  quoteLineId: z.string().uuid(),
  quotedQty: z.number().positive().nullable().optional(),
  quotedUom: z.string().max(16).nullable().optional(),
  unitPrice: z.number().min(0).nullable().optional(),
  lineMarginPercent: z.number().min(-100).max(99.99).nullable().optional(),
  marginLocked: z.boolean().optional(),
  note: z.string().max(2000).nullable().optional(),
})

export type LineEditInput = z.infer<typeof LineEdit>

/**
 * Saves a per-line edit. Autosave calls this on every change, so it is
 * deliberately small and does not touch anything the rep did not name.
 */
export async function updateQuoteLine(input: LineEditInput): Promise<LineActionState> {
  const parsed = LineEdit.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid change' }

  try {
    const { supabase, line, quote, session } = await loadLine(parsed.data.quoteLineId)
    const patch: Partial<QuoteLineRow> = {}

    if ('quotedQty' in parsed.data) patch.quoted_qty = parsed.data.quotedQty
    if ('quotedUom' in parsed.data) patch.quoted_uom = parsed.data.quotedUom
    if ('note' in parsed.data) patch.note = parsed.data.note
    if ('marginLocked' in parsed.data) patch.margin_locked = parsed.data.marginLocked

    // A margin the rep types wins over a price, and a price they type wins over
    // a margin. Whichever they touched last is the one they meant.
    if (parsed.data.lineMarginPercent !== undefined) {
      patch.line_margin_percent = parsed.data.lineMarginPercent
      const cost = await costOfLine(supabase, line.product_id)
      if (cost !== null && parsed.data.lineMarginPercent !== null) {
        patch.unit_price = priceFromMargin(cost, parsed.data.lineMarginPercent)
      }
    } else if (parsed.data.unitPrice !== undefined) {
      patch.unit_price = parsed.data.unitPrice
      patch.price_source = 'manual'
      patch.price_missing = parsed.data.unitPrice === null
      const cost = await costOfLine(supabase, line.product_id)
      patch.line_margin_percent = marginOf(parsed.data.unitPrice, cost)
    }

    const qty = (patch.quoted_qty as number | null | undefined) ?? line.quoted_qty
    const price = (patch.unit_price as number | null | undefined) ?? line.unit_price
    patch.extended_price = extendedPrice(price, qty)

    // Anything the rep touched is no longer waiting on them.
    patch.was_corrected = true

    const { error } = await supabase.from('quote_lines').update(patch).eq('id', line.id)
    if (error) return { error: error.message }

    await retotal(supabase, quote.id)

    await tenantDb(session.tenant.id).log({
      action: 'quote_line.edited',
      entityType: 'quote_line',
      entityId: line.id,
      quoteId: quote.id,
      rfqId: quote.rfq_id,
      actorId: session.user.id,
      detail: patch,
    })

    return { savedAt: Date.now() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not save that change' }
  }
}

/** Accepting a line clears its flags without changing anything about it. */
export async function acceptQuoteLine(quoteLineId: string): Promise<LineActionState> {
  try {
    const { supabase, line, session } = await loadLine(quoteLineId)
    const { error } = await supabase
      .from('quote_lines')
      .update({
        is_flagged: false,
        flag_reasons: [],
        accepted_by: session.user.id,
        accepted_at: new Date().toISOString(),
      })
      .eq('id', line.id)

    return error ? { error: error.message } : { savedAt: Date.now() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not accept that line' }
  }
}

/**
 * Changes which product a line is matched to, and records the correction.
 *
 * This is the single most valuable event in the product (6.8) — it is what the
 * matcher learns from — so it re-prices the line from the new product at the
 * same time, rather than leaving a rep to fix the price separately.
 */
export async function changeQuoteLineMatch(
  quoteLineId: string,
  productId: string,
): Promise<LineActionState> {
  try {
    const { supabase, line, quote, session } = await loadLine(quoteLineId)

    const { data: product } = await supabase
      .from('products')
      .select('id, sku, description, category, manufacturer, list_price, cost, uom, on_hand_qty, lead_time_days, is_stocked')
      .eq('id', productId)
      .maybeSingle()

    if (!product) return { error: 'That product could not be found' }

    // Price the new product the way the pipeline would (6.5), not at list.
    // Re-matching is the most common correction a rep makes, so pricing the
    // replacement at list quietly undid the customer's discount on exactly the
    // lines a human had just put right — and stamped `manual` on it, so the
    // line claimed a rep had chosen that price.
    const { data: ruleRows } = await supabase
      .from('price_rules')
      .select('id, scope, method, value, customer_id, product_id, category, manufacturer, contract_code, job_name, precedence, effective_from, effective_to')
      .or(
        quote.customer_id
          ? `customer_id.eq.${quote.customer_id},customer_id.is.null`
          : 'customer_id.is.null',
      )

    const rules = ((ruleRows ?? []) as unknown as ApplicableRule[]).map((rule) => ({
      ...rule,
      value: Number(rule.value),
    }))

    // A job-scoped rule is keyed on the job name, which lives on the RFQ.
    const { data: rfqRow } = await supabase
      .from('rfqs')
      .select('job_name')
      .eq('id', quote.rfq_id)
      .maybeSingle()

    const priced = priceLine(
      {
        id: product.id,
        category: product.category,
        manufacturer: product.manufacturer,
        list_price: product.list_price === null ? null : Number(product.list_price),
        cost: product.cost === null ? null : Number(product.cost),
      },
      rules,
      { customerId: quote.customer_id, jobName: rfqRow?.job_name ?? null },
    )

    const { data: rfqLine } = line.rfq_line_id
      ? await supabase.from('rfq_lines').select('raw_text').eq('id', line.rfq_line_id).maybeSingle()
      : { data: null }

    const qty = line.quoted_qty

    const { error } = await supabase
      .from('quote_lines')
      .update({
        product_id: product.id,
        match_confidence: 1,
        match_band: 'high',
        match_method: 'manual',
        match_reasoning: `${session.user.full_name ?? 'A rep'} chose this product`,
        alternatives: [],
        list_price: priced.listPrice,
        unit_price: priced.unitPrice,
        price_rule_id: priced.priceRuleId,
        price_source: priced.priceSource,
        price_missing: priced.priceMissing,
        extended_price: extendedPrice(priced.unitPrice, qty),
        line_margin_percent: marginOf(priced.unitPrice, product.cost === null ? null : Number(product.cost)),
        quoted_uom: product.uom,
        on_hand_qty: product.on_hand_qty,
        lead_time_days: product.lead_time_days,
        stock_shortfall: qty !== null && product.on_hand_qty !== null && qty > Number(product.on_hand_qty),
        // The match is settled, but the price may not be: a product with no
        // list price, or a cost-plus rule with no cost, still needs a person.
        is_flagged: priced.flagReasons.length > 0,
        flag_reasons: priced.flagReasons,
        was_corrected: true,
        accepted_by: session.user.id,
        accepted_at: new Date().toISOString(),
      })
      .eq('id', line.id)

    if (error) return { error: error.message }

    // The learning loop. Scoped to this tenant and this contractor (6.8).
    if (rfqLine?.raw_text) {
      const { error: correctionError } = await supabase.rpc('record_correction' as never, {
        target_tenant: session.tenant.id,
        target_customer: quote.customer_id,
        p_raw_text: rfqLine.raw_text,
        p_matched_product: line.product_id,
        p_corrected_product: product.id,
        p_kind: 'match',
        p_quote_line: line.id,
        p_rfq: quote.rfq_id,
      } as never)
      // A correction that failed to record is a lost lesson, not a lost edit —
      // the rep's change stands either way.
      if (correctionError) console.error('record_correction failed', correctionError)
    }

    await retotal(supabase, quote.id)

    await tenantDb(session.tenant.id).log({
      action: 'quote_line.rematched',
      entityType: 'quote_line',
      entityId: line.id,
      quoteId: quote.id,
      rfqId: quote.rfq_id,
      actorId: session.user.id,
      detail: { from: line.product_id, to: product.id, sku: product.sku },
    })

    revalidatePath(`/quotes/${quote.id}`)
    return { savedAt: Date.now() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not change that match' }
  }
}

export async function deleteQuoteLine(quoteLineId: string): Promise<LineActionState> {
  try {
    const { supabase, line, quote, session } = await loadLine(quoteLineId)
    const { error } = await supabase.from('quote_lines').delete().eq('id', line.id)
    if (error) return { error: error.message }

    await retotal(supabase, quote.id)
    await tenantDb(session.tenant.id).log({
      action: 'quote_line.deleted',
      entityType: 'quote_line',
      entityId: line.id,
      quoteId: quote.id,
      rfqId: quote.rfq_id,
      actorId: session.user.id,
      detail: { product_id: line.product_id, line_number: line.line_number },
    })

    revalidatePath(`/quotes/${quote.id}`)
    return { savedAt: Date.now() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not delete that line' }
  }
}

export async function addQuoteLine(quoteId: string, productId: string): Promise<LineActionState> {
  const session = await requireSession()
  const supabase = await createClient()

  const [{ data: quote }, { data: product }, { data: last }] = await Promise.all([
    supabase.from('quotes').select('id, rfq_id, status').eq('id', quoteId).maybeSingle(),
    supabase
      .from('products')
      .select('id, sku, uom, list_price, cost, on_hand_qty, lead_time_days')
      .eq('id', productId)
      .maybeSingle(),
    supabase
      .from('quote_lines')
      .select('line_number')
      .eq('quote_id', quoteId)
      .order('line_number', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (!quote) return { error: 'That quote could not be found' }
  if (quote.status !== 'draft' && quote.status !== 'in_review') {
    return { error: 'This quote has already been sent' }
  }
  if (!product) return { error: 'That product could not be found' }

  const listPrice = product.list_price === null ? null : Number(product.list_price)

  const { error } = await supabase.from('quote_lines').insert({
    tenant_id: session.tenant.id,
    quote_id: quoteId,
    line_number: (last?.line_number ?? 0) + 1,
    product_id: product.id,
    match_confidence: 1,
    match_band: 'high',
    match_method: 'manual',
    match_reasoning: 'Added by hand',
    requested_qty: 1,
    quoted_qty: 1,
    quoted_uom: product.uom,
    list_price: listPrice,
    unit_price: listPrice,
    price_source: 'manual',
    price_missing: listPrice === null,
    extended_price: listPrice,
    line_margin_percent: marginOf(listPrice, product.cost === null ? null : Number(product.cost)),
    on_hand_qty: product.on_hand_qty,
    lead_time_days: product.lead_time_days,
    is_manual: true,
  })

  if (error) return { error: error.message }

  await retotal(supabase, quoteId)
  revalidatePath(`/quotes/${quoteId}`)
  return { savedAt: Date.now() }
}

// ---------------------------------------------------------------------------
// Quote-level
// ---------------------------------------------------------------------------

const QuoteEdit = z.object({
  quoteId: z.string().uuid(),
  terms: z.string().max(5000).nullable().optional(),
  validUntil: z.string().nullable().optional(),
  deliveryNotes: z.string().max(2000).nullable().optional(),
  customerContactName: z.string().max(200).nullable().optional(),
  customerContactEmail: z.string().max(320).nullable().optional(),
})

export async function updateQuote(input: z.infer<typeof QuoteEdit>): Promise<LineActionState> {
  const parsed = QuoteEdit.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid change' }

  await requireSession()
  const supabase = await createClient()

  const patch: Partial<QuoteRow> = {}
  if ('terms' in parsed.data) patch.terms = parsed.data.terms
  if ('validUntil' in parsed.data) patch.valid_until = parsed.data.validUntil
  if ('deliveryNotes' in parsed.data) patch.delivery_notes = parsed.data.deliveryNotes
  if ('customerContactName' in parsed.data) patch.customer_contact_name = parsed.data.customerContactName
  if ('customerContactEmail' in parsed.data) patch.customer_contact_email = parsed.data.customerContactEmail

  const { error } = await supabase.from('quotes').update(patch).eq('id', parsed.data.quoteId)
  return error ? { error: error.message } : { savedAt: Date.now() }
}

/**
 * Applies a margin to every unlocked line (6.9).
 *
 * Lines the rep locked keep their price. Lines with no cost cannot be priced
 * from a margin at all, so they are left alone and counted — quietly skipping
 * them would leave a rep believing a margin applied when it did not.
 */
export async function applyQuoteMargin(
  quoteId: string,
  marginPercent: number,
): Promise<LineActionState & { applied?: number; skipped?: number }> {
  if (!Number.isFinite(marginPercent) || marginPercent >= 100) {
    return { error: 'Enter a margin below 100%' }
  }

  const session = await requireSession()
  const supabase = await createClient()

  // Every per-line action goes through loadLine(), which refuses a quote that
  // has been sent. This one reached the lines directly and so was the one way
  // to reprice a quote already in a customer's inbox.
  const { data: quote } = await supabase
    .from('quotes')
    .select('id, status')
    .eq('id', quoteId)
    .maybeSingle()

  if (!quote) return { error: 'That quote could not be found' }
  if (quote.status !== 'draft' && quote.status !== 'in_review') {
    return { error: 'This quote has already been sent' }
  }

  const { data: lines, error } = await supabase
    .from('quote_lines')
    .select('id, quoted_qty, margin_locked, products(cost)')
    .eq('quote_id', quoteId)

  if (error) return { error: error.message }

  let applied = 0
  let skipped = 0

  for (const line of lines ?? []) {
    const cost = (line.products as unknown as { cost: number | null } | null)?.cost
    if (line.margin_locked || cost === null || cost === undefined) {
      skipped += 1
      continue
    }

    const unitPrice = priceFromMargin(Number(cost), marginPercent)
    await supabase
      .from('quote_lines')
      .update({
        unit_price: unitPrice,
        line_margin_percent: marginPercent,
        price_source: 'manual',
        price_missing: unitPrice === null,
        extended_price: extendedPrice(unitPrice, line.quoted_qty),
      })
      .eq('id', line.id)
    applied += 1
  }

  await supabase.from('quotes').update({ global_margin_percent: marginPercent }).eq('id', quoteId)
  await retotal(supabase, quoteId)

  await tenantDb(session.tenant.id).log({
    action: 'quote.margin_applied',
    entityType: 'quote',
    entityId: quoteId,
    quoteId,
    actorId: session.user.id,
    detail: { margin: marginPercent, applied, skipped },
  })

  revalidatePath(`/quotes/${quoteId}`)
  return { savedAt: Date.now(), applied, skipped }
}

export type ProductSearchResult = {
  id: string
  sku: string
  description: string
  manufacturer: string | null
  manufacturerPartNumber: string | null
  listPrice: number | null
  uom: string
  onHand: number | null
}

/** The catalogue picker behind "change match" and "add a line" (6.9). */
export async function searchProducts(query: string): Promise<ProductSearchResult[]> {
  const trimmed = query.trim()
  if (trimmed.length < 2) return []

  const { tenant } = await requireSession()
  const supabase = await createClient()

  const escaped = trimmed.replace(/[%,()]/g, ' ')

  const { data } = await supabase
    .from('products')
    .select('id, sku, description, manufacturer, manufacturer_part_number, list_price, uom, on_hand_qty')
    .eq('tenant_id', tenant.id)
    .eq('is_active', true)
    .or(
      `sku.ilike.%${escaped}%,description.ilike.%${escaped}%,manufacturer_part_number.ilike.%${escaped}%`,
    )
    .limit(20)

  return (data ?? []).map((row) => ({
    id: row.id,
    sku: row.sku,
    description: row.description,
    manufacturer: row.manufacturer,
    manufacturerPartNumber: row.manufacturer_part_number,
    listPrice: row.list_price === null ? null : Number(row.list_price),
    uom: row.uom,
    onHand: row.on_hand_qty === null ? null : Number(row.on_hand_qty),
  }))
}

// ---------------------------------------------------------------------------

async function costOfLine(
  supabase: Awaited<ReturnType<typeof createClient>>,
  productId: string | null,
): Promise<number | null> {
  if (!productId) return null
  const { data } = await supabase.from('products').select('cost').eq('id', productId).maybeSingle()
  return data?.cost === null || data?.cost === undefined ? null : Number(data.cost)
}

/** Keeps the header total honest after any line change. */
async function retotal(
  supabase: Awaited<ReturnType<typeof createClient>>,
  quoteId: string,
): Promise<void> {
  const { data } = await supabase.from('quote_lines').select('extended_price').eq('quote_id', quoteId)
  const subtotal = (data ?? []).reduce(
    (sum, line) => sum + (line.extended_price === null ? 0 : Number(line.extended_price)),
    0,
  )
  await supabase
    .from('quotes')
    .update({ subtotal: Math.round(subtotal * 100) / 100, total: Math.round(subtotal * 100) / 100 })
    .eq('id', quoteId)
}
