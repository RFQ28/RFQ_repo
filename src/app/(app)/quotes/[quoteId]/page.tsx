import { notFound } from 'next/navigation'
import { requireSession } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'
import { ReviewScreen, type ReviewLine, type ReviewQuote, type SourceLine } from './review-screen'

/**
 * The review screen (PRD 6.9).
 *
 * Original document on the left, matched draft on the right, flagged lines at
 * the top. If a rep trusts what they see they send in ten minutes; if they
 * re-check all eighty lines themselves, we have saved them nothing.
 */
export default async function QuotePage({ params }: { params: Promise<{ quoteId: string }> }) {
  const { quoteId } = await params
  const { user, tenant } = await requireSession()
  const supabase = await createClient()

  const { data: quote } = await supabase
    .from('quotes')
    .select(
      `id, rfq_id, quote_number, status, subtotal, total, terms, valid_until, delivery_notes,
       global_margin_percent, customer_contact_name, customer_contact_email,
       customers(id, name),
       rfqs(id, job_name, contractor_name, due_date, received_at, claimed_by, delivery_address,
            users:claimed_by(full_name, email),
            inbound_emails(subject, from_address, from_name, received_at))`,
    )
    .eq('tenant_id', tenant.id)
    .eq('id', quoteId)
    .maybeSingle()

  if (!quote) notFound()

  const rfq = quote.rfqs as unknown as {
    id: string
    job_name: string | null
    contractor_name: string | null
    due_date: string | null
    received_at: string
    claimed_by: string | null
    delivery_address: string | null
    users: { full_name: string | null; email: string } | null
    inbound_emails: { subject: string | null; from_address: string; from_name: string | null; received_at: string } | null
  }

  const [{ data: lines }, { data: rfqLines }] = await Promise.all([
    supabase
      .from('quote_lines')
      .select(
        `id, line_number, rfq_line_id, product_id, match_confidence, match_band, match_method,
         match_reasoning, alternatives, requested_qty, requested_uom, quoted_qty, quoted_uom,
         uom_conversion_applied, uom_conversion_note, uom_unresolved, list_price, unit_price,
         price_source, price_missing, line_margin_percent, margin_locked, extended_price,
         is_substitution, substituted_for_text, on_hand_qty, stock_shortfall, lead_time_days,
         is_flagged, flag_reasons, note, is_manual,
         products(sku, description, manufacturer, manufacturer_part_number, uom, cost)`,
      )
      .eq('quote_id', quoteId)
      .order('line_number', { ascending: true }),
    supabase
      .from('rfq_lines')
      .select('id, line_number, raw_text, is_parsed, parse_error, source_document')
      .eq('rfq_id', rfq.id)
      .order('line_number', { ascending: true }),
  ])

  const reviewLines: ReviewLine[] = (lines ?? []).map((line) => {
    const product = line.products as unknown as {
      sku: string
      description: string
      manufacturer: string | null
      manufacturer_part_number: string | null
      uom: string
      cost: number | null
    } | null

    return {
      id: line.id,
      lineNumber: line.line_number,
      rfqLineId: line.rfq_line_id,
      productId: line.product_id,
      sku: product?.sku ?? null,
      productDescription: product?.description ?? null,
      manufacturer: product?.manufacturer ?? null,
      manufacturerPartNumber: product?.manufacturer_part_number ?? null,
      cost: product?.cost === null || product?.cost === undefined ? null : Number(product.cost),
      matchConfidence: line.match_confidence === null ? null : Number(line.match_confidence),
      matchBand: line.match_band,
      matchMethod: line.match_method,
      matchReasoning: line.match_reasoning,
      alternatives: (line.alternatives ?? []) as ReviewLine['alternatives'],
      requestedQty: numeric(line.requested_qty),
      requestedUom: line.requested_uom,
      quotedQty: numeric(line.quoted_qty),
      quotedUom: line.quoted_uom,
      uomConversionApplied: line.uom_conversion_applied,
      uomConversionNote: line.uom_conversion_note,
      uomUnresolved: line.uom_unresolved,
      listPrice: numeric(line.list_price),
      unitPrice: numeric(line.unit_price),
      priceSource: line.price_source,
      priceMissing: line.price_missing,
      lineMarginPercent: numeric(line.line_margin_percent),
      marginLocked: line.margin_locked,
      extendedPrice: numeric(line.extended_price),
      isSubstitution: line.is_substitution,
      substitutedForText: line.substituted_for_text,
      onHandQty: numeric(line.on_hand_qty),
      stockShortfall: line.stock_shortfall,
      leadTimeDays: line.lead_time_days,
      isFlagged: line.is_flagged,
      flagReasons: line.flag_reasons ?? [],
      note: line.note,
      isManual: line.is_manual,
    }
  })

  const source: SourceLine[] = (rfqLines ?? []).map((row) => ({
    id: row.id,
    lineNumber: row.line_number,
    rawText: row.raw_text,
    isParsed: row.is_parsed,
    parseError: row.parse_error,
    sourceDocument: row.source_document,
  }))

  const reviewQuote: ReviewQuote = {
    id: quote.id,
    rfqId: rfq.id,
    quoteNumber: quote.quote_number,
    status: quote.status,
    subtotal: numeric(quote.subtotal),
    total: numeric(quote.total),
    terms: quote.terms,
    validUntil: quote.valid_until,
    deliveryNotes: quote.delivery_notes,
    globalMarginPercent: numeric(quote.global_margin_percent),
    customerContactName: quote.customer_contact_name,
    customerContactEmail: quote.customer_contact_email,
    customerName: (quote.customers as unknown as { name: string } | null)?.name ?? rfq.contractor_name,
    jobName: rfq.job_name,
    dueDate: rfq.due_date,
    receivedAt: rfq.received_at,
    deliveryAddress: rfq.delivery_address,
    emailSubject: rfq.inbound_emails?.subject ?? null,
    emailFrom: rfq.inbound_emails?.from_name ?? rfq.inbound_emails?.from_address ?? null,
    claimedBy: rfq.claimed_by,
    claimedByName: rfq.users?.full_name ?? rfq.users?.email ?? null,
  }

  return (
    <ReviewScreen quote={reviewQuote} lines={reviewLines} source={source} currentUserId={user.id} />
  )
}

function numeric(value: number | string | null): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
