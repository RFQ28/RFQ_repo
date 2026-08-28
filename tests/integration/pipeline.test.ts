import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient } from '@/lib/supabase/admin'
import { tenantDb } from '@/lib/supabase/tenant'
import { matchRfq } from '@/lib/jobs/handlers/match-rfq'
import type { JobRow } from '@/lib/db/types'

/**
 * The draft pipeline, end to end, against the real database.
 *
 * The unit suite proves the decisions in isolation; this proves the wiring —
 * that a matched line really does come back with the right conversion, the
 * right price, the right flags and the right quote row behind it.
 *
 * It provisions its own distributor and removes it afterwards.
 */

const hasCredentials =
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

const suite = hasCredentials ? describe : describe.skip

suite('draft pipeline', () => {
  const stamp = Date.now()
  let tenantId: string
  let customerId: string
  let rfqId: string
  let romexId: string
  let connectorId: string

  beforeAll(async () => {
    const admin = adminClient()

    const { data: tenant, error } = await admin.rpc('provision_tenant' as never, {
      p_slug: `pipeline-${stamp}`,
      p_name: 'Pipeline Test Distributor',
      p_owner_email: null,
      p_inbound_address: null,
    } as never)
    if (error) throw new Error(`provision_tenant: ${error.message}`)
    tenantId = (tenant as unknown as { id: string }).id

    const db = tenantDb(tenantId)

    const { data: products, error: productError } = await db
      .from('products')
      .insert([
        {
          sku: 'MC-12-2-250',
          description: '12/2 MC cable with ground, 250ft roll',
          manufacturer: 'Southwire',
          manufacturer_part_number: '68583421',
          category: 'WIRE',
          list_price: 320,
          cost: 210,
          uom: 'ROLL',
          base_uom: 'FT',
          units_per_package: 250,
          on_hand_qty: 4,
        },
        {
          sku: 'EMT-12-SS',
          description: '1/2 EMT set screw connector, steel',
          manufacturer: 'Bridgeport',
          manufacturer_part_number: '230-SST',
          category: 'FITTINGS',
          list_price: 1.4,
          cost: 0.72,
          uom: 'EA',
          on_hand_qty: 500,
        },
        {
          sku: 'EMT-34-SS',
          description: '3/4 EMT set screw connector, steel',
          manufacturer: 'Bridgeport',
          category: 'FITTINGS',
          list_price: 2.1,
          cost: 1.15,
          uom: 'EA',
          on_hand_qty: 300,
        },
        {
          sku: 'QUOTE-ONLY',
          description: 'Special order switchgear section',
          category: 'GEAR',
          list_price: null,
          uom: 'EA',
          on_hand_qty: 0,
        },
      ])
      .select('id, sku')
    if (productError) throw new Error(`seed products: ${productError.message}`)

    const bySku = new Map((products ?? []).map((p) => [p.sku, p.id]))
    romexId = bySku.get('MC-12-2-250')!
    connectorId = bySku.get('EMT-12-SS')!

    const { data: customer, error: customerError } = await db
      .from('customers')
      .insert({ name: 'Riverside Electric', external_id: 'C100' })
      .select('id')
      .single()
    if (customerError) throw new Error(`seed customer: ${customerError.message}`)
    customerId = customer!.id

    // Riverside pays list minus 22%.
    const { error: ruleError } = await db.from('price_rules').insert({
      scope: 'customer',
      method: 'discount_percent_off_list',
      value: 22,
      customer_id: customerId,
    })
    if (ruleError) throw new Error(`seed price rule: ${ruleError.message}`)

    const { data: rfq, error: rfqError } = await db
      .from('rfqs')
      .insert({
        classification: 'new_rfq',
        status: 'matching',
        customer_id: customerId,
        job_name: 'Riverside Medical Phase 2',
      })
      .select('id')
      .single()
    if (rfqError) throw new Error(`seed rfq: ${rfqError.message}`)
    rfqId = rfq!.id

    // What the parser would have produced from the contractor's email.
    const { error: lineError } = await db.from('rfq_lines').insert([
      {
        rfq_id: rfqId, line_number: 1,
        raw_text: '500ft of 12/2 MC cable',
        description: '12/2 MC cable', quantity: 500, uom_as_written: 'ft',
        is_parsed: true,
      },
      {
        rfq_id: rfqId, line_number: 2,
        raw_text: '25 ea 1/2in EMT set screw connector',
        description: '1/2in EMT set screw connector', quantity: 25, uom_as_written: 'ea',
        is_parsed: true,
      },
      {
        rfq_id: rfqId, line_number: 3,
        raw_text: '2 ea Special order switchgear section',
        description: 'Special order switchgear section', quantity: 2, uom_as_written: 'ea',
        is_parsed: true,
      },
      {
        rfq_id: rfqId, line_number: 4,
        raw_text: '10 ea blivet flange model ZZ',
        description: 'blivet flange model ZZ', quantity: 10, uom_as_written: 'ea',
        is_parsed: true,
      },
      {
        rfq_id: rfqId, line_number: 5,
        raw_text: '???  48',
        is_parsed: false, parse_error: 'Could not tell what this line is asking for',
      },
    ])
    if (lineError) throw new Error(`seed rfq lines: ${lineError.message}`)
  })

  afterAll(async () => {
    if (tenantId) await adminClient().from('tenants').delete().eq('id', tenantId)
  })

  it('drafts a quote from the RFQ', async () => {
    const job = {
      id: '00000000-0000-0000-0000-000000000001',
      tenant_id: tenantId,
      kind: 'match_rfq',
      payload: { rfqId },
      rfq_id: rfqId,
    } as unknown as JobRow

    await matchRfq(job)

    const db = tenantDb(tenantId)
    const { data: quote } = await db
      .from('quotes')
      .select('id, quote_number, status, subtotal')
      .eq('rfq_id', rfqId)
      .single()

    expect(quote).toBeTruthy()
    expect(quote!.quote_number).toMatch(/^Q-\d+$/)
    expect(quote!.status).toBe('draft')

    const { data: lines } = await db
      .from('quote_lines')
      .select('*')
      .eq('quote_id', quote!.id)
      .order('line_number')

    expect(lines).toHaveLength(5)

    // --- line 1: converted to whole rolls and discounted ------------------
    const romex = lines!.find((l) => l.line_number === 1)!
    expect(romex.product_id).toBe(romexId)
    expect(Number(romex.quoted_qty)).toBe(2)
    expect(romex.quoted_uom).toBe('ROLL')
    expect(romex.uom_conversion_applied).toBe(true)
    expect(romex.uom_conversion_note).toMatch(/500 FT requested; quoting 2 ROLL/)
    expect(Number(romex.unit_price)).toBeCloseTo(249.6, 2) // 320 less 22%
    expect(Number(romex.extended_price)).toBeCloseTo(499.2, 2)
    expect(romex.flag_reasons).toContain('uom_converted')

    // --- line 2: matched, priced, nothing to flag -------------------------
    const connector = lines!.find((l) => l.line_number === 2)!
    expect(connector.product_id).toBe(connectorId)
    expect(Number(connector.quoted_qty)).toBe(25)
    expect(Number(connector.unit_price)).toBeCloseTo(1.092, 3)

    // The 3/4 connector must not have won a 1/2 line.
    expect(connector.match_reasoning).toBeTruthy()

    // --- line 3: no list price, so no invented price ----------------------
    const switchgear = lines!.find((l) => l.line_number === 3)!
    if (switchgear.product_id) {
      expect(switchgear.unit_price).toBeNull()
      expect(switchgear.price_missing).toBe(true)
      expect(switchgear.flag_reasons).toContain('price_missing')
    }

    // --- line 4: nothing in the catalogue matches -------------------------
    const blivet = lines!.find((l) => l.line_number === 4)!
    expect(blivet.match_band).toBe('no_match')
    expect(blivet.is_flagged).toBe(true)

    // --- line 5: unparsed, but still present ------------------------------
    const unparsed = lines!.find((l) => l.line_number === 5)!
    expect(unparsed.flag_reasons).toContain('unparsed')
    expect(unparsed.is_flagged).toBe(true)

    // --- the RFQ moved on and the total only counts priced lines ----------
    const { data: rfq } = await db.from('rfqs').select('status, draft_ready_at').eq('id', rfqId).single()
    expect(rfq!.status).toBe('draft_ready')
    expect(rfq!.draft_ready_at).toBeTruthy()

    const priced = lines!.filter((l) => l.extended_price !== null)
    const expected = priced.reduce((sum, l) => sum + Number(l.extended_price), 0)
    expect(Number(quote!.subtotal)).toBeCloseTo(expected, 2)
  })

  it('is idempotent — a retry does not double the quote', async () => {
    const job = {
      id: '00000000-0000-0000-0000-000000000002',
      tenant_id: tenantId,
      kind: 'match_rfq',
      payload: { rfqId },
      rfq_id: rfqId,
    } as unknown as JobRow

    const db = tenantDb(tenantId)
    const { data: before } = await db.from('quotes').select('id, quote_number').eq('rfq_id', rfqId).single()

    await matchRfq(job)

    const { data: quotes } = await db.from('quotes').select('id, quote_number').eq('rfq_id', rfqId)
    expect(quotes).toHaveLength(1)
    expect(quotes![0].quote_number).toBe(before!.quote_number)

    const { count } = await db
      .from('quote_lines')
      .select('id', { count: 'exact', head: true })
      .eq('quote_id', before!.id)
    expect(count).toBe(5)
  })

  it('refuses to rewrite a quote that has been sent', async () => {
    const db = tenantDb(tenantId)
    await db.from('quotes').update({ status: 'sent' }).eq('rfq_id', rfqId)

    const job = {
      id: '00000000-0000-0000-0000-000000000003',
      tenant_id: tenantId,
      kind: 'match_rfq',
      payload: { rfqId },
      rfq_id: rfqId,
    } as unknown as JobRow

    await expect(matchRfq(job)).rejects.toThrow(/already sent|refusing to rewrite/i)

    await db.from('quotes').update({ status: 'draft' }).eq('rfq_id', rfqId)
  })

  it('records the run in the audit trail', async () => {
    const { data: entries } = await tenantDb(tenantId)
      .from('activity_log')
      .select('action')
      .eq('rfq_id', rfqId)

    const actions = (entries ?? []).map((entry) => entry.action)
    expect(actions).toContain('rfq.drafted')
  })
})
