/**
 * Seeds one distributor with a realistic RFQ and draft quote, for looking at
 * the review screen with real data in it.
 *
 * Development only. Uses the sanctioned onboarding path -- provision_tenant()
 * plus the on_auth_user_created trigger -- so the rows land exactly as they
 * would in production, rather than being hand-stitched around it.
 *
 *   node scripts/seed-demo.mjs          # create
 *   node scripts/seed-demo.mjs --reset  # delete the tenant, then create
 *
 * Undo entirely with scripts/unseed-demo.mjs.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const SLUG = 'northgate'
const OWNER_EMAIL = 'rep@northgate-demo.test'
const OWNER_PASSWORD = 'quotedesk-demo-2026'

// ---------------------------------------------------------------------------

function env() {
  let file = {}
  try {
    file = Object.fromEntries(
      readFileSync('.env.local', 'utf8')
        .split('\n')
        .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
        .map((l) => {
          const i = l.indexOf('=')
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
        }),
    )
  } catch {
    /* fall through to process.env */
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? file.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? file.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  return { url, key }
}

const { url, key } = env()
const db = createClient(url, key, { auth: { persistSession: false } })

function must(label, { data, error }) {
  if (error) throw new Error(`${label}: ${error.message}`)
  return data
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

async function removeExisting() {
  const { data: tenant } = await db.from('tenants').select('id').eq('slug', SLUG).maybeSingle()

  if (tenant) {
    // Everything tenant-scoped cascades from the tenant row.
    must('delete tenant', await db.from('tenants').delete().eq('id', tenant.id))
    console.log(`  removed tenant ${SLUG}`)
  }

  // The auth user does not cascade from the tenant; find and drop it by email.
  const { data: list } = await db.auth.admin.listUsers({ perPage: 200 })
  const existing = list?.users?.find((u) => u.email?.toLowerCase() === OWNER_EMAIL)
  if (existing) {
    await db.auth.admin.deleteUser(existing.id)
    console.log(`  removed auth user ${OWNER_EMAIL}`)
  }

  await db.from('invitations').delete().eq('email', OWNER_EMAIL)
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/** sku, mfr, mpn, description, category, list, cost, uom, onHand, lead, stocked */
const CATALOGUE = [
  ['EMT-050-C',   'Steel City', 'TC122',    '1/2in EMT set screw connector, steel',                 'Fittings',   0.89,   0.52, 'EA',  4200, null, true],
  ['EMT-075-C',   'Steel City', 'TC123',    '3/4in EMT set screw connector, steel',                 'Fittings',   1.24,   0.71, 'EA',  2800, null, true],
  ['EMT-100-C',   'Steel City', 'TC124',    '1in EMT set screw connector, steel',                   'Fittings',   2.15,   1.28, 'EA',   940, null, true],
  ['EMT-050-CPL', 'Steel City', 'TK111',    '1/2in EMT set screw coupling, steel',                  'Fittings',   0.76,   0.44, 'EA',  5100, null, true],
  ['EMT-075-CPL', 'Steel City', 'TK112',    '3/4in EMT set screw coupling, steel',                  'Fittings',   1.08,   0.63, 'EA',  3300, null, true],
  ['CND-EMT-050', 'Allied',     'EMT12',    '1/2in EMT conduit, galvanized steel, 10ft length',     'Conduit',    9.40,   6.10, 'EA',  1800,   3, true],
  ['CND-EMT-075', 'Allied',     'EMT34',    '3/4in EMT conduit, galvanized steel, 10ft length',     'Conduit',   15.20,   9.85, 'EA',  1250,   3, true],
  ['CND-EMT-100', 'Allied',     'EMT1',     '1in EMT conduit, galvanized steel, 10ft length',       'Conduit',   24.60,  16.40, 'EA',   420,   5, true],
  ['WIR-12THHN-B','Southwire',  '22964001', '12 AWG THHN stranded copper, black, 500ft spool',      'Wire',     138.00,  96.20, 'SPOOL', 84,   2, true],
  ['WIR-12THHN-W','Southwire',  '22964002', '12 AWG THHN stranded copper, white, 500ft spool',      'Wire',     138.00,  96.20, 'SPOOL', 71,   2, true],
  ['WIR-12THHN-G','Southwire',  '22964003', '12 AWG THHN stranded copper, green, 500ft spool',      'Wire',     138.00,  96.20, 'SPOOL', 63,   2, true],
  ['WIR-10THHN-B','Southwire',  '22966001', '10 AWG THHN stranded copper, black, 500ft spool',      'Wire',     214.00, 151.00, 'SPOOL', 38,   2, true],
  ['MC-122-250',  'Southwire',  '68580021', '12/2 MC cable with ground, aluminum armor, 250ft coil','Cable',    189.00, 132.50, 'COIL',  46,   4, true],
  ['MC-123-250',  'Southwire',  '68580022', '12/3 MC cable with ground, aluminum armor, 250ft coil','Cable',    247.00, 174.00, 'COIL',  22,   4, true],
  ['MC-102-250',  'Southwire',  '68580031', '10/2 MC cable with ground, aluminum armor, 250ft coil','Cable',    286.00, 201.00, 'COIL',  14,   6, true],
  ['BOX-4SQ-15',  'RACO',       '190',      '4in square outlet box, 1-1/2in deep, welded steel',    'Boxes',      3.42,   2.05, 'EA',  2600, null, true],
  ['BOX-4SQ-21',  'RACO',       '191',      '4in square outlet box, 2-1/8in deep, welded steel',    'Boxes',      4.18,   2.51, 'EA',  1900, null, true],
  ['BOX-411-21',  'RACO',       '203',      '4-11/16in square outlet box, 2-1/8in deep, steel',     'Boxes',      7.85,   4.90, 'EA',   540, null, true],
  ['MUD-1G-050',  'RACO',       '767',      '1-gang mud ring, 1/2in raised, steel',                 'Boxes',      1.62,   0.94, 'EA',  3100, null, true],
  ['MUD-2G-050',  'RACO',       '768',      '2-gang mud ring, 1/2in raised, steel',                 'Boxes',      2.28,   1.34, 'EA',  1400, null, true],
  ['BRK-1P20',    'Square D',   'QO120',    'QO 1-pole 20A 120/240V plug-on circuit breaker',       'Breakers',  12.80,   8.15, 'EA',   860, null, true],
  ['BRK-1P15',    'Square D',   'QO115',    'QO 1-pole 15A 120/240V plug-on circuit breaker',       'Breakers',  12.80,   8.15, 'EA',   910, null, true],
  ['BRK-2P30',    'Square D',   'QO230',    'QO 2-pole 30A 120/240V plug-on circuit breaker',       'Breakers',  31.40,  20.90, 'EA',   240, null, true],
  ['BRK-2P50',    'Square D',   'QO250',    'QO 2-pole 50A 120/240V plug-on circuit breaker',       'Breakers',  38.90,  25.60, 'EA',   118, null, true],
  ['PNL-42-225',  'Square D',   'QO142M225','QO 42-space 225A main breaker load center, NEMA 1',    'Gear',     412.00, 289.00, 'EA',     6,  21, true],
  ['REC-20A-SP',  'Hubbell',    'HBL5362',  '20A 125V duplex receptacle, spec grade, ivory',        'Devices',    6.95,   4.10, 'EA',  1750, null, true],
  ['REC-20A-GF',  'Hubbell',    'GFR5352',  '20A 125V GFCI receptacle, self-test, ivory',           'Devices',   28.40,  19.20, 'EA',   410, null, true],
  ['SW-1P20-SP',  'Hubbell',    'HBL1221',  '20A 120/277V single pole toggle switch, spec grade',   'Devices',    7.20,   4.35, 'EA',  1320, null, true],
  ['SW-3W20-SP',  'Hubbell',    'HBL1223',  '20A 120/277V three way toggle switch, spec grade',     'Devices',   11.60,   7.05, 'EA',   780, null, true],
  ['PLT-1G-SS',   'Hubbell',    'SS1',      '1-gang stainless steel wall plate, smooth',            'Devices',    2.14,   1.22, 'EA',  2400, null, true],
  ['STR-UNI-10',  'Unistrut',   'P1000T10', 'P1000 12ga solid strut channel, 1-5/8in, 10ft',        'Support',   38.50,  26.40, 'EA',   310,   7, true],
  ['STR-UNI-CLP', 'Unistrut',   'P1010',    'P1010 strut pipe clamp, 1/2in, electrogalvanized',     'Support',    2.86,   1.68, 'EA',  1900, null, true],
  ['THR-ROD-38',  'Unistrut',   'AR38',     '3/8in threaded rod, zinc plated, 10ft',                'Support',    8.90,   5.70, 'EA',   640, null, true],
  ['LUG-350-2H',  'Burndy',     'YA34L2',   '350 MCM two hole compression lug, long barrel',        'Terminations', 18.40, 12.30, 'EA', 210, 10, true],
  ['LUG-500-2H',  'Burndy',     'YA40L2',   '500 MCM two hole compression lug, long barrel',        'Terminations', 26.70, 18.10, 'EA', 140, 10, true],
  ['GRD-BUS-12',  'nVent',      'GB12',     '12 position ground bus bar with insulator',            'Grounding',  34.20,  23.80, 'EA',    92, 14, true],
  ['WHP-6FT-12',  'Southwire',  '55082421', '6ft fixture whip, 12 AWG, 1/2in flex',                 'Cable',     11.30,   7.45, 'EA',   980, null, true],
  ['ANC-WEDGE38', 'Hilti',      'KB338',    '3/8in x 3in wedge anchor, carbon steel, zinc',         'Anchors',    1.94,   1.06, 'EA',  4100, null, true],
  ['SEAL-FIRE-C', '3M',         'CP25WB',   'CP 25WB+ firestop caulk, 10.1oz tube',                 'Firestop',  16.80,  11.40, 'EA',   260,   5, true],
  // Deliberately not stocked -- exercises the non_stock flag.
  ['XFR-45KVA',   'Square D',   'EE45T3H',  '45 KVA 480V-208Y/120V dry type transformer',           'Gear',    3180.00, 2410.00, 'EA',     0,  35, false],
  // Deliberately no list price -- exercises price_missing.
  ['CUS-BEND-4',  'Allied',     'RB4CUST',  '4in rigid conduit custom bend, per drawing',           'Conduit',   null,    null, 'EA',  null, 28, true],
]

// ---------------------------------------------------------------------------
// The RFQ, as a contractor actually types it
// ---------------------------------------------------------------------------

/** rawText, description, qty, uom, mfr, partNumber, isParsed, parseError, doc */
const RFQ_LINES = [
  ['1  1/2" EMT set screw connectors - 500 ea',        '1/2in EMT set screw connector', 500, 'ea', null, null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['2  3/4" EMT set screw connectors - 250 ea',        '3/4in EMT set screw connector', 250, 'ea', null, null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['3  1/2" EMT couplings - 400 ea',                   '1/2in EMT coupling',            400, 'ea', null, null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['4  1/2" EMT conduit - 3000 lf',                    '1/2in EMT conduit',            3000, 'lf', null, null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['5  3/4" EMT conduit - 1200 lf',                    '3/4in EMT conduit',            1200, 'lf', null, null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['6  #12 THHN black - 8 MFT',                        '12 AWG THHN black',               8, 'mft', 'Southwire', null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['7  #12 THHN white - 8 MFT',                        '12 AWG THHN white',               8, 'mft', 'Southwire', null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['8  #12 THHN green - 4 MFT',                        '12 AWG THHN green',               4, 'mft', 'Southwire', null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['9  12/2 MC cable w/ ground - 6 coils',             '12/2 MC cable with ground',       6, 'coils', null, null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['10 12/3 MC cable w/ ground - 30 coils',            '12/3 MC cable with ground',      30, 'coils', null, null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['11 4" square boxes 1-1/2" deep - 300 ea',          '4in square box 1-1/2in deep',   300, 'ea', 'RACO', null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['12 4-11/16 square boxes 2-1/8 deep - 120 ea',      '4-11/16in square box',          120, 'ea', 'RACO', null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['13 1G mud rings 1/2" raised - 300 ea',             '1-gang mud ring 1/2in raised',  300, 'ea', 'RACO', null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['14 QO120 breakers - 84 ea',                        'QO 1-pole 20A breaker',          84, 'ea', 'Square D', 'QO120', true, null, 'Riverside Medical - takeoff.xlsx'],
  ['15 QO250 breakers - 12 ea',                        'QO 2-pole 50A breaker',          12, 'ea', 'Square D', 'QO250', true, null, 'Riverside Medical - takeoff.xlsx'],
  ['16 20A spec grade recepts ivory - 220 ea',         '20A spec grade receptacle',     220, 'ea', 'Hubbell', null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['17 20A GFCI recepts - 48 ea',                      '20A GFCI receptacle',            48, 'ea', 'Hubbell', null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['18 P1000 strut 10ft sticks - 180 ea',              'P1000 strut channel 10ft',      180, 'ea', 'Unistrut', 'P1000T10', true, null, 'Riverside Medical - takeoff.xlsx'],
  ['19 3/8 all thread 10ft - 200 ea',                  '3/8in threaded rod 10ft',       200, 'ea', null, null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['20 500 MCM 2 hole lugs - 24 ea',                   '500 MCM two hole lug',           24, 'ea', 'Burndy', null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['21 45 KVA xfmr 480-208Y/120 - 1 ea',               '45 KVA transformer',              1, 'ea', 'Square D', null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['22 4" rigid custom bends per sheet E-401 - 6 ea',  '4in rigid custom bend',           6, 'ea', null, null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['23 Cutler Hammer BR120 breakers - 40 ea',          'BR120 breaker',                  40, 'ea', 'Cutler Hammer', 'BR120', true, null, 'Riverside Medical - takeoff.xlsx'],
  ['24 firestop caulk - 3 cases',                      'firestop caulk',                  3, 'cases', '3M', null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['25 wire pulling lube - 6 buckets',                 'wire pulling lubricant',          6, 'buckets', null, null, true, null, 'Riverside Medical - takeoff.xlsx'],
  ['Panel schedule + riser on sheet E-2, see attached','', null, null, null, null, false,
   'riser-E2.pdf is a PDF — open it and add these lines by hand', 'riser-E2.pdf'],
]

// ---------------------------------------------------------------------------

async function seed() {
  console.log(`\nSeeding "${SLUG}" into ${url}\n`)

  console.log('- tenant')
  const tenant = must(
    'provision_tenant',
    await db.rpc('provision_tenant', {
      p_slug: SLUG,
      p_name: 'Northgate Electric Supply',
      p_owner_email: OWNER_EMAIL,
      p_inbound_address: 'quotes@northgate-demo.test',
    }),
  )
  const tenantId = tenant.id

  must(
    'tenant settings',
    await db
      .from('tenants')
      .update({
        quote_number_prefix: 'NG',
        quote_terms: 'Net 30. Prices firm for 30 days. Freight prepaid and allowed on orders over $2,500.',
        quote_validity_days: 30,
        status: 'active',
      })
      .eq('id', tenantId),
  )

  console.log('- owner login (trigger consumes the invitation)')
  const created = await db.auth.admin.createUser({
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: 'Dana Whitfield' },
  })
  if (created.error) throw new Error(`createUser: ${created.error.message}`)
  const userId = created.data.user.id

  // The trigger sets role + tenant from the invitation; make sure it landed.
  const profile = must('profile', await db.from('users').select('role, tenant_id').eq('id', userId).single())
  if (profile.tenant_id !== tenantId) {
    throw new Error(`the invitation was not consumed — profile is ${JSON.stringify(profile)}`)
  }
  must('name', await db.from('users').update({ full_name: 'Dana Whitfield' }).eq('id', userId))
  console.log(`    ${OWNER_EMAIL} / ${OWNER_PASSWORD}  (role: ${profile.role})`)

  console.log('- customer')
  const customer = must(
    'customer',
    await db
      .from('customers')
      .insert({
        tenant_id: tenantId,
        external_id: 'C-10428',
        name: 'Voltaic Contracting LLC',
        contact_name: 'Marcus Feld',
        contact_email: 'mfeld@voltaic-demo.test',
        phone: '(503) 555-0147',
        billing_address: '2214 SE Ankeny St, Portland, OR 97214',
      })
      .select('id')
      .single(),
  )

  must(
    'customer identifier',
    await db.from('customer_identifiers').insert({
      tenant_id: tenantId,
      customer_id: customer.id,
      kind: 'email_domain',
      value: 'voltaic-demo.test',
    }),
  )

  console.log(`- catalogue (${CATALOGUE.length} products)`)
  const products = must(
    'products',
    await db
      .from('products')
      .insert(
        CATALOGUE.map(([sku, mfr, mpn, description, category, list, cost, uom, onHand, lead, stocked]) => ({
          tenant_id: tenantId,
          sku,
          manufacturer: mfr,
          manufacturer_part_number: mpn,
          description,
          category,
          list_price: list,
          cost,
          uom,
          on_hand_qty: onHand,
          lead_time_days: lead,
          is_stocked: stocked,
        })),
      )
      .select('id, sku, list_price, cost, uom, on_hand_qty, lead_time_days'),
  )
  const bySku = new Map(products.map((p) => [p.sku, p]))

  console.log('- price rules')
  const rules = must(
    'price rules',
    await db
      .from('price_rules')
      .insert([
        {
          tenant_id: tenantId,
          scope: 'customer',
          method: 'discount_percent_off_list',
          value: 22,
          customer_id: customer.id,
          precedence: 0,
        },
        {
          tenant_id: tenantId,
          scope: 'customer_category',
          method: 'discount_percent_off_list',
          value: 31,
          customer_id: customer.id,
          category: 'Wire',
          precedence: 0,
        },
      ])
      .select('id, scope'),
  )
  const customerRule = rules.find((r) => r.scope === 'customer').id
  const wireRule = rules.find((r) => r.scope === 'customer_category').id

  console.log('- inbound email')
  const email = must(
    'email',
    await db
      .from('inbound_emails')
      .insert({
        tenant_id: tenantId,
        message_id: '<CAF9x2demo-riverside-med@mail.voltaic-demo.test>',
        thread_id: 'AAQkAGRemo0001',
        from_address: 'mfeld@voltaic-demo.test',
        from_name: 'Marcus Feld',
        to_addresses: ['quotes@northgate-demo.test'],
        subject: 'Riverside Medical Office Building - Phase 2 rough-in pricing needed by Fri',
        body_text:
          'Dana,\n\nCan you price the attached takeoff for Riverside Medical Phase 2? ' +
          'We need it back by Friday morning, bid is due Monday at 2pm.\n\n' +
          'Panel schedule and riser are on sheet E-2 in the second attachment.\n\n' +
          'Delivery to 4400 NE Halsey, Portland. Ship in two releases if you need to.\n\nThanks,\nMarcus',
        received_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
        attachment_hash: 'demo0000000000000000000000000000000000000000000000000000000000ab',
      })
      .select('id')
      .single(),
  )

  console.log('- rfq')
  const dueDate = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10)
  const rfq = must(
    'rfq',
    await db
      .from('rfqs')
      .insert({
        tenant_id: tenantId,
        email_id: email.id,
        classification: 'new_rfq',
        status: 'draft_ready',
        customer_id: customer.id,
        customer_confidence: 0.95,
        job_name: 'Riverside Medical Office Building — Phase 2',
        contractor_name: 'Marcus Feld',
        due_date: dueDate,
        delivery_address: '4400 NE Halsey St, Portland, OR 97213',
        received_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
        draft_ready_at: new Date(Date.now() - 2.6 * 3600_000).toISOString(),
      })
      .select('id')
      .single(),
  )

  console.log(`- rfq lines (${RFQ_LINES.length})`)
  const rfqLines = must(
    'rfq lines',
    await db
      .from('rfq_lines')
      .insert(
        RFQ_LINES.map(([raw, desc, qty, uom, mfr, pn, parsed, err, doc], i) => ({
          tenant_id: tenantId,
          rfq_id: rfq.id,
          line_number: i + 1,
          raw_text: raw,
          description: desc || null,
          quantity: qty,
          uom_as_written: uom,
          manufacturer: mfr,
          part_number: pn,
          is_parsed: parsed,
          parse_error: err,
          source_document: doc,
        })),
      )
      .select('id, line_number'),
  )
  const lineId = (n) => rfqLines.find((l) => l.line_number === n)?.id ?? null

  console.log('- quote')
  const quoteNumber = must('quote number', await db.rpc('next_quote_number', { target_tenant: tenantId }))
  const quote = must(
    'quote',
    await db
      .from('quotes')
      .insert({
        tenant_id: tenantId,
        rfq_id: rfq.id,
        customer_id: customer.id,
        quote_number: quoteNumber,
        status: 'draft',
        terms: 'Net 30. Prices firm for 30 days. Freight prepaid and allowed on orders over $2,500.',
        valid_until: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
        customer_contact_name: 'Marcus Feld',
        customer_contact_email: 'mfeld@voltaic-demo.test',
      })
      .select('id')
      .single(),
  )

  // -------------------------------------------------------------------------
  // Quote lines.
  //
  // Priced the way lib/quote/pricing.ts would: 22% off list for this customer,
  // 31% off for the Wire category. Every flag the review screen can show is
  // represented at least once, so the design can be judged with the states it
  // actually has to carry rather than a happy path.
  // -------------------------------------------------------------------------

  const money = (n) => (n === null ? null : Math.round(n * 10000) / 10000
  )
  const ext = (p, q) => (p === null || q === null ? null : Math.round(p * q * 100) / 100)
  const margin = (p, c) => (p === null || c === null || p === 0 ? null : Math.round(((p - c) / p) * 1000) / 10)

  /** A clean, high-confidence, rule-priced line. */
  function clean(n, sku, qty, uom, opts = {}) {
    const p = bySku.get(sku)
    const list = Number(p.list_price)
    const discount = opts.wire ? 31 : 22
    const unit = money(list * (1 - discount / 100))
    const q = opts.quotedQty ?? qty
    return {
      tenant_id: tenantId,
      quote_id: quote.id,
      rfq_line_id: lineId(n),
      line_number: n,
      product_id: p.id,
      match_confidence: opts.confidence ?? 0.96,
      match_band: 'high',
      match_method: opts.method ?? 'semantic',
      match_reasoning: opts.reasoning ?? 'Description is a close match. Specification matches: size',
      alternatives: [],
      requested_qty: qty,
      requested_uom: uom,
      quoted_qty: q,
      quoted_uom: p.uom,
      uom_conversion_applied: Boolean(opts.conversionNote),
      uom_conversion_note: opts.conversionNote ?? null,
      list_price: list,
      unit_price: unit,
      price_rule_id: opts.wire ? wireRule : customerRule,
      price_source: opts.wire ? 'customer_category' : 'customer',
      line_margin_percent: margin(unit, Number(p.cost)),
      extended_price: ext(unit, q),
      on_hand_qty: p.on_hand_qty,
      lead_time_days: p.lead_time_days,
      is_flagged: false,
      flag_reasons: [],
      ...(opts.extra ?? {}),
    }
  }

  /** A flagged line: same shape, plus the reasons a rep has to look at it. */
  function flagged(base, reasons, extra = {}) {
    return { ...base, is_flagged: true, flag_reasons: reasons, ...extra }
  }

  // Only the lines built by hand below need their product row in scope; the
  // rest go through clean(), which looks its own product up by SKU.
  const bend = bySku.get('CUS-BEND-4')
  const brk120 = bySku.get('BRK-1P20')
  const seal = bySku.get('SEAL-FIRE-C')

  const quoteLines = [
    clean(1, 'EMT-050-C', 500, 'ea'),
    clean(2, 'EMT-075-C', 250, 'ea'),
    clean(3, 'EMT-050-CPL', 400, 'ea'),

    // 3000 lf of 1/2in EMT arrives as 300 ten-foot sticks.
    flagged(
      clean(4, 'CND-EMT-050', 3000, 'lf', {
        quotedQty: 300,
        conversionNote: '3,000 FT ÷ 10 FT per length = 300 EA',
      }),
      ['uom_converted'],
    ),
    flagged(
      clean(5, 'CND-EMT-075', 1200, 'lf', {
        quotedQty: 120,
        conversionNote: '1,200 FT ÷ 10 FT per length = 120 EA',
      }),
      ['uom_converted'],
    ),

    // 8 MFT = 8,000 ft = 16 spools of 500ft.
    flagged(
      clean(6, 'WIR-12THHN-B', 8, 'mft', {
        wire: true, quotedQty: 16,
        conversionNote: '8 MFT = 8,000 FT ÷ 500 FT per spool = 16 SPOOL',
      }),
      ['uom_converted'],
    ),
    flagged(
      clean(7, 'WIR-12THHN-W', 8, 'mft', {
        wire: true, quotedQty: 16,
        conversionNote: '8 MFT = 8,000 FT ÷ 500 FT per spool = 16 SPOOL',
      }),
      ['uom_converted'],
    ),
    flagged(
      clean(8, 'WIR-12THHN-G', 4, 'mft', {
        wire: true, quotedQty: 8,
        conversionNote: '4 MFT = 4,000 FT ÷ 500 FT per spool = 8 SPOOL',
      }),
      ['uom_converted'],
    ),

    clean(9, 'MC-122-250', 6, 'coils', {
      confidence: 0.98,
      reasoning: 'Description is a close match. Specification matches: conductors 12/2',
    }),

    // Wants 30 coils, 22 on hand.
    flagged(
      clean(10, 'MC-123-250', 30, 'coils', {
        confidence: 0.98,
        reasoning: 'Description is a close match. Specification matches: conductors 12/3',
      }),
      ['stock_shortfall'],
      { stock_shortfall: true },
    ),

    clean(11, 'BOX-4SQ-15', 300, 'ea'),

    // Two boxes fit equally well -- 4-11/16 vs 4in square, both 2-1/8 deep.
    flagged(
      clean(12, 'BOX-411-21', 120, 'ea', { confidence: 0.79 }),
      ['ambiguous'],
      {
        match_band: 'medium',
        match_reasoning: 'Description text overlaps (71% similar). Specification matches: size 2-1/8',
        alternatives: [
          {
            product_id: bySku.get('BOX-4SQ-21').id,
            sku: 'BOX-4SQ-21',
            description: '4in square outlet box, 2-1/8in deep, welded steel',
            confidence: 0.771,
            method: 'trigram',
            reasoning: 'Description text overlaps (68% similar). Specification matches: size 2-1/8',
          },
        ],
      },
    ),

    clean(13, 'MUD-1G-050', 300, 'ea'),
    clean(14, 'BRK-1P20', 84, 'ea', {
      confidence: 0.96, method: 'mpn',
      reasoning: 'Manufacturer part number QO120 matches exactly. Same manufacturer (Square D)',
    }),
    clean(15, 'BRK-2P50', 12, 'ea', {
      confidence: 0.96, method: 'mpn',
      reasoning: 'Manufacturer part number QO250 matches exactly. Same manufacturer (Square D)',
    }),
    clean(16, 'REC-20A-SP', 220, 'ea'),
    clean(17, 'REC-20A-GF', 48, 'ea'),
    clean(18, 'STR-UNI-10', 180, 'ea', {
      confidence: 0.96, method: 'mpn',
      reasoning: 'Manufacturer part number P1000T10 matches exactly. Same manufacturer (Unistrut)',
    }),
    clean(19, 'THR-ROD-38', 200, 'ea'),

    // Line says 500 MCM; the top candidate is the 350 MCM lug.
    flagged(
      clean(20, 'LUG-500-2H', 24, 'ea', { confidence: 0.53 }),
      ['low_confidence', 'spec_conflict'],
      {
        match_band: 'low',
        match_reasoning:
          'Description text overlaps (62% similar). Specification differs: gauge 500 vs 350',
        alternatives: [
          {
            product_id: bySku.get('LUG-350-2H').id,
            sku: 'LUG-350-2H',
            description: '350 MCM two hole compression lug, long barrel',
            confidence: 0.512,
            method: 'trigram',
            reasoning: 'Description text overlaps (66% similar). Specification differs: gauge 500 vs 350',
          },
        ],
      },
    ),

    // Not a stocked item, 35 day lead.
    flagged(
      clean(21, 'XFR-45KVA', 1, 'ea', { confidence: 0.94 }),
      ['non_stock', 'stock_shortfall'],
      { stock_shortfall: true },
    ),

    // Custom bend: matched, but the catalogue carries no price for it.
    {
      tenant_id: tenantId,
      quote_id: quote.id,
      rfq_line_id: lineId(22),
      line_number: 22,
      product_id: bend.id,
      match_confidence: 0.88,
      match_band: 'medium',
      match_method: 'trigram',
      match_reasoning: 'Description text overlaps (74% similar). Specification matches: size 4',
      alternatives: [],
      requested_qty: 6,
      requested_uom: 'ea',
      quoted_qty: 6,
      quoted_uom: 'EA',
      list_price: null,
      unit_price: null,
      price_source: 'none',
      price_missing: true,
      extended_price: null,
      on_hand_qty: null,
      lead_time_days: 28,
      is_flagged: true,
      flag_reasons: ['price_missing'],
    },

    // A brand this distributor does not carry -- substitution offered.
    flagged(
      {
        tenant_id: tenantId,
        quote_id: quote.id,
        rfq_line_id: lineId(23),
        line_number: 23,
        product_id: brk120.id,
        match_confidence: 0.41,
        match_band: 'low',
        match_method: 'substitution',
        match_reasoning:
          'No match for "Cutler Hammer BR120 breakers". Offering BRK-1P20 as an equivalent',
        alternatives: [
          {
            product_id: bySku.get('BRK-1P15').id,
            sku: 'BRK-1P15',
            description: 'QO 1-pole 15A 120/240V plug-on circuit breaker',
            confidence: 0,
            method: 'substitution',
            reasoning: 'equivalent for Cutler Hammer BR120 breakers',
          },
        ],
        requested_qty: 40,
        requested_uom: 'ea',
        quoted_qty: 40,
        quoted_uom: 'EA',
        list_price: Number(brk120.list_price),
        unit_price: money(Number(brk120.list_price) * 0.78),
        price_rule_id: customerRule,
        price_source: 'customer',
        line_margin_percent: margin(money(Number(brk120.list_price) * 0.78), Number(brk120.cost)),
        extended_price: ext(money(Number(brk120.list_price) * 0.78), 40),
        on_hand_qty: brk120.on_hand_qty,
        lead_time_days: brk120.lead_time_days,
        is_substitution: true,
        substituted_for_text: 'Cutler Hammer BR120 breakers',
      },
      ['substitution', 'low_confidence'],
    ),

    // "3 cases" -- CTN has no global factor, so the unit cannot be resolved.
    flagged(
      {
        tenant_id: tenantId,
        quote_id: quote.id,
        rfq_line_id: lineId(24),
        line_number: 24,
        product_id: seal.id,
        match_confidence: 0.93,
        match_band: 'high',
        match_method: 'semantic',
        match_reasoning: 'Description is a close match (81% similar)',
        alternatives: [],
        requested_qty: 3,
        requested_uom: 'cases',
        quoted_qty: null,
        quoted_uom: 'EA',
        uom_unresolved: true,
        uom_conversion_note:
          'How many tubes are in a case is a property of this product, and the catalogue does not say',
        list_price: Number(seal.list_price),
        unit_price: money(Number(seal.list_price) * 0.78),
        price_rule_id: customerRule,
        price_source: 'customer',
        line_margin_percent: margin(money(Number(seal.list_price) * 0.78), Number(seal.cost)),
        extended_price: null,
        on_hand_qty: seal.on_hand_qty,
        lead_time_days: seal.lead_time_days,
      },
      ['uom_unresolved'],
    ),

    // Nothing in the catalogue is remotely this.
    {
      tenant_id: tenantId,
      quote_id: quote.id,
      rfq_line_id: lineId(25),
      line_number: 25,
      product_id: null,
      match_confidence: 0.18,
      match_band: 'no_match',
      match_method: 'none',
      match_reasoning: 'Nothing in the catalogue matched this line',
      alternatives: [],
      requested_qty: 6,
      requested_uom: 'buckets',
      quoted_qty: null,
      quoted_uom: null,
      list_price: null,
      unit_price: null,
      price_source: 'none',
      price_missing: true,
      extended_price: null,
      is_flagged: true,
      flag_reasons: ['no_match'],
    },

    // The PDF nobody can read yet.
    {
      tenant_id: tenantId,
      quote_id: quote.id,
      rfq_line_id: lineId(26),
      line_number: 26,
      product_id: null,
      match_confidence: 0,
      match_band: 'no_match',
      match_method: 'none',
      match_reasoning: 'This line could not be read from the document',
      alternatives: [],
      quoted_qty: null,
      list_price: null,
      unit_price: null,
      price_source: 'none',
      price_missing: true,
      extended_price: null,
      is_flagged: true,
      flag_reasons: ['unparsed'],
    },
  ]

  // A bulk insert sends the union of every row's keys, so a row that omits a
  // column gets an explicit NULL rather than its default. Every not-null
  // column with a default has to be spelled out on every row.
  const LINE_DEFAULTS = {
    match_confidence: null,
    match_band: 'no_match',
    match_method: null,
    match_reasoning: null,
    alternatives: [],
    requested_qty: null,
    requested_uom: null,
    quoted_qty: null,
    quoted_uom: null,
    uom_conversion_applied: false,
    uom_conversion_note: null,
    uom_unresolved: false,
    list_price: null,
    unit_price: null,
    price_rule_id: null,
    price_source: null,
    price_missing: false,
    line_margin_percent: null,
    margin_locked: false,
    extended_price: null,
    is_substitution: false,
    substitution_id: null,
    substituted_for_text: null,
    on_hand_qty: null,
    stock_shortfall: false,
    lead_time_days: null,
    is_flagged: false,
    flag_reasons: [],
    accepted_by: null,
    accepted_at: null,
    was_corrected: false,
    note: null,
    is_manual: false,
  }

  console.log(`- quote lines (${quoteLines.length})`)
  must(
    'quote lines',
    await db.from('quote_lines').insert(quoteLines.map((l) => ({ ...LINE_DEFAULTS, ...l }))),
  )

  const subtotal =
    Math.round(quoteLines.reduce((s, l) => s + (l.extended_price ?? 0), 0) * 100) / 100
  must('totals', await db.from('quotes').update({ subtotal, total: subtotal }).eq('id', quote.id))

  must(
    'activity',
    await db.from('activity_log').insert({
      tenant_id: tenantId,
      actor_kind: 'system',
      entity_type: 'rfq',
      entity_id: rfq.id,
      rfq_id: rfq.id,
      quote_id: quote.id,
      action: 'rfq.drafted',
      detail: {
        lines: quoteLines.length,
        flagged: quoteLines.filter((l) => l.is_flagged).length,
        subtotal,
      },
    }),
  )

  const flaggedCount = quoteLines.filter((l) => l.is_flagged).length
  console.log(`\nDone.`)
  console.log(`  quote     ${quoteNumber} — $${subtotal.toLocaleString('en-US')}`)
  console.log(`  lines     ${quoteLines.length} (${flaggedCount} flagged, ${quoteLines.length - flaggedCount} clean)`)
  console.log(`\n  Sign in at /login → "Sign in with a password instead"`)
  console.log(`    ${OWNER_EMAIL}`)
  console.log(`    ${OWNER_PASSWORD}\n`)
}

// ---------------------------------------------------------------------------

const reset = process.argv.includes('--reset')
if (reset) {
  console.log('\nRemoving any previous demo data')
  await removeExisting()
}

try {
  await seed()
} catch (error) {
  console.error(`\nSeed failed: ${error.message}`)
  console.error('Re-run with --reset to clear a partial seed first.\n')
  process.exit(1)
}
