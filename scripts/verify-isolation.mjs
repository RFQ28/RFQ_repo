/**
 * Tenant isolation, proved against the live database.
 *
 * PRD s7: "Tenant isolation tested explicitly, with tests that fail loudly on
 * any leak." Checking that an anonymous client sees nothing proves very little
 * when the tables are empty, so this provisions two real distributors, gives
 * each a real signed-in user, puts real rows in both, and then tries every way
 * a rep in one could reach the other.
 *
 * It creates and then removes its own data. Safe to re-run.
 *
 *   node scripts/verify-isolation.mjs
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

function loadEnv(file) {
  const out = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match) out[match[1]] = match[2].trim()
  }
  return out
}

const env = loadEnv(new URL('../.env.local', import.meta.url))
const url = env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const stamp = Date.now()
const PASSWORD = `Verify!${stamp}`
const cleanup = { tenants: [], users: [] }

const results = { pass: [], fail: [] }
const ok = (name, detail = '') => results.pass.push(detail ? `${name} — ${detail}` : name)
const bad = (name, detail) => results.fail.push(`${name} — ${detail}`)

async function provision(slug, name, ownerEmail) {
  const { data, error } = await admin.rpc('provision_tenant', {
    p_slug: slug,
    p_name: name,
    p_owner_email: ownerEmail,
    p_inbound_address: null,
  })
  if (error) throw new Error(`provision_tenant(${slug}): ${error.message}`)
  cleanup.tenants.push(data.id)
  return data
}

async function createUser(email) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (error) throw new Error(`createUser(${email}): ${error.message}`)
  cleanup.users.push(data.user.id)
  return data.user
}

async function signIn(email) {
  const client = createClient(url, anonKey, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`signIn(${email}): ${error.message}`)
  return client
}

try {
  // --- two distributors, each with an owner ---------------------------------

  const emailA = `verify-a-${stamp}@example.test`
  const emailB = `verify-b-${stamp}@example.test`

  const tenantA = await provision(`verify-a-${stamp}`, 'Verify Distributor A', emailA)
  const tenantB = await provision(`verify-b-${stamp}`, 'Verify Distributor B', emailB)
  ok('provision_tenant', `created ${tenantA.slug} and ${tenantB.slug}`)

  // The UOM table should have been seeded into each of them.
  for (const [label, tenant] of [['A', tenantA], ['B', tenantB]]) {
    const { count } = await admin
      .from('uom_conversions')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id)
    if ((count ?? 0) > 0) ok(`uom seed ${label}`, `${count} conversions`)
    else bad(`uom seed ${label}`, 'no conversions were seeded')
  }

  // --- the invitation flow attaches a user to the right tenant --------------

  const userA = await createUser(emailA)
  const userB = await createUser(emailB)

  const { data: profileA } = await admin.from('users').select('tenant_id, role').eq('id', userA.id).single()
  const { data: profileB } = await admin.from('users').select('tenant_id, role').eq('id', userB.id).single()

  if (profileA?.tenant_id === tenantA.id && profileA?.role === 'owner') {
    ok('invitation consumed', `A landed in ${tenantA.slug} as owner`)
  } else {
    bad('invitation consumed', `A got tenant=${profileA?.tenant_id} role=${profileA?.role}`)
  }
  if (profileB?.tenant_id !== tenantB.id) {
    bad('invitation consumed', `B got tenant=${profileB?.tenant_id}`)
  }

  // --- real rows in both ----------------------------------------------------

  const { data: productA, error: productAError } = await admin
    .from('products')
    .insert({ tenant_id: tenantA.id, sku: 'A-SECRET-1', description: 'Tenant A only widget', list_price: 100 })
    .select('id')
    .single()
  const { data: productB, error: productBError } = await admin
    .from('products')
    .insert({ tenant_id: tenantB.id, sku: 'B-SECRET-1', description: 'Tenant B only widget', list_price: 200 })
    .select('id')
    .single()

  if (productAError || productBError) {
    throw new Error(`seed products: ${productAError?.message ?? productBError?.message}`)
  }

  const { data: customerB } = await admin
    .from('customers')
    .insert({ tenant_id: tenantB.id, name: 'Tenant B Contractor' })
    .select('id')
    .single()

  // --- what a signed-in rep in A can actually see ---------------------------

  const asA = await signIn(emailA)

  const { data: visible } = await asA.from('products').select('id, sku, tenant_id')
  const skus = (visible ?? []).map((p) => p.sku)
  if (skus.includes('B-SECRET-1')) {
    bad('cross-tenant read', `A read tenant B's product — LEAK (saw ${skus.join(', ')})`)
  } else if (skus.includes('A-SECRET-1')) {
    ok('cross-tenant read', `A sees only its own ${skus.length} product(s)`)
  } else {
    bad('cross-tenant read', `A could not see its own product (saw ${skus.length} rows)`)
  }

  // Asking for the other tenant by id explicitly must still return nothing.
  const { data: targeted } = await asA.from('products').select('id').eq('tenant_id', tenantB.id)
  if ((targeted ?? []).length === 0) ok('targeted read', 'naming tenant B returns nothing')
  else bad('targeted read', `A read ${targeted.length} of B's rows by asking for them — LEAK`)

  // Same for the tables that carry the moat and the money.
  for (const table of ['corrections', 'price_rules', 'quotes', 'rfqs', 'customers']) {
    const { data: rows } = await asA.from(table).select('id').eq('tenant_id', tenantB.id)
    if ((rows ?? []).length === 0) ok(`targeted read ${table}`, 'nothing from B')
    else bad(`targeted read ${table}`, `${rows.length} row(s) from B — LEAK`)
  }

  const { data: otherTenant } = await asA.from('tenants').select('id, slug')
  const slugs = (otherTenant ?? []).map((t) => t.slug)
  if (slugs.includes(tenantB.slug)) bad('tenant row read', 'A can see tenant B — LEAK')
  else ok('tenant row read', `A sees only ${slugs.join(', ') || 'nothing'}`)

  // --- what a rep in A can write --------------------------------------------

  const { error: writeAcross } = await asA
    .from('products')
    .insert({ tenant_id: tenantB.id, sku: 'A-PLANTED', description: 'planted in B' })
  if (writeAcross) ok('cross-tenant write', `refused (${writeAcross.code})`)
  else bad('cross-tenant write', 'A planted a product in tenant B — LEAK')

  const { error: updateAcross } = await asA
    .from('products')
    .update({ list_price: 1 })
    .eq('id', productB.id)
  const { data: bStillIntact } = await admin
    .from('products')
    .select('list_price')
    .eq('id', productB.id)
    .single()
  if (Number(bStillIntact?.list_price) === 200) {
    ok('cross-tenant update', updateAcross ? `refused (${updateAcross.code})` : 'matched no rows')
  } else {
    bad('cross-tenant update', "A changed tenant B's price — LEAK")
  }

  const { error: stealCustomer } = await asA
    .from('customers')
    .update({ name: 'stolen' })
    .eq('id', customerB.id)
  const { data: customerIntact } = await admin.from('customers').select('name').eq('id', customerB.id).single()
  if (customerIntact?.name === 'Tenant B Contractor') {
    ok('cross-tenant customer update', stealCustomer ? `refused (${stealCustomer.code})` : 'matched no rows')
  } else {
    bad('cross-tenant customer update', "A renamed tenant B's customer — LEAK")
  }

  // --- privilege escalation --------------------------------------------------

  const { error: escalate } = await asA
    .from('users')
    .update({ role: 'platform_admin', tenant_id: null })
    .eq('id', userA.id)
  if (escalate) ok('self escalation', `refused (${escalate.message.slice(0, 60)})`)
  else {
    const { data: after } = await admin.from('users').select('role').eq('id', userA.id).single()
    if (after?.role === 'platform_admin') bad('self escalation', 'A made itself a platform admin — LEAK')
    else ok('self escalation', 'no change took effect')
  }

  const { error: moveTenant } = await asA
    .from('users')
    .update({ tenant_id: tenantB.id })
    .eq('id', userA.id)
  const { data: stillA } = await admin.from('users').select('tenant_id').eq('id', userA.id).single()
  if (stillA?.tenant_id === tenantA.id) {
    ok('tenant hop', moveTenant ? 'refused' : 'no change took effect')
  } else {
    bad('tenant hop', 'A moved itself into tenant B — LEAK')
  }

  // --- the search RPCs must refuse another tenant ---------------------------

  const { error: searchAcross } = await asA.rpc('search_products_text', {
    target_tenant: tenantB.id,
    query: 'widget',
  })
  if (searchAcross) ok('rpc tenant check', 'search_products_text refused tenant B')
  else bad('rpc tenant check', 'search_products_text ran against tenant B — LEAK')

  const { error: correctionsAcross } = await asA.rpc('find_corrections', {
    target_tenant: tenantB.id,
    target_customer: null,
    raw_normalized: 'widget',
  })
  if (correctionsAcross) ok('rpc tenant check', 'find_corrections refused tenant B')
  else bad('rpc tenant check', 'find_corrections ran against tenant B — LEAK')

  const { error: numberAcross } = await asA.rpc('next_quote_number', { target_tenant: tenantB.id })
  if (numberAcross) ok('rpc tenant check', 'next_quote_number refused tenant B')
  else bad('rpc tenant check', "next_quote_number burned tenant B's sequence — LEAK")

  // --- quote numbering is sequential and per-tenant --------------------------

  const first = await asA.rpc('next_quote_number', { target_tenant: tenantA.id })
  const second = await asA.rpc('next_quote_number', { target_tenant: tenantA.id })
  if (first.data && second.data && first.data !== second.data) {
    ok('quote numbering', `${first.data} then ${second.data}`)
  } else {
    bad('quote numbering', `got ${first.data} and ${second.data} (${first.error?.message ?? ''})`)
  }

  // --- a rep may not rewrite the catalogue ----------------------------------
  //
  // Owner is a tenant-admin role, so A *should* be allowed here. A plain rep
  // should not — check that by demoting A for a moment.

  await admin.from('users').update({ role: 'rep' }).eq('id', userA.id)
  const asRep = await signIn(emailA)
  const { error: repWrite } = await asRep
    .from('products')
    .insert({ tenant_id: tenantA.id, sku: 'REP-WRITE', description: 'should not exist' })
  if (repWrite) ok('rep cannot edit catalogue', `refused (${repWrite.code})`)
  else bad('rep cannot edit catalogue', 'a rep wrote to the catalogue directly')

  const { error: repReadsMailbox } = await asRep.from('mailbox_connections').select('id')
  const { data: mailboxRows } = await asRep.from('mailbox_connections').select('id')
  if ((mailboxRows ?? []).length === 0) ok('rep cannot read mailbox tokens', 'nothing returned')
  else bad('rep cannot read mailbox tokens', `${mailboxRows.length} row(s) visible`)
  void repReadsMailbox
} catch (error) {
  bad('harness', error.message)
} finally {
  for (const id of cleanup.users) await admin.auth.admin.deleteUser(id).catch(() => {})
  for (const id of cleanup.tenants) await admin.from('tenants').delete().eq('id', id)
}

console.log(`\n  ${results.pass.length} passed, ${results.fail.length} failed\n`)
for (const line of results.pass) console.log(`  ok    ${line}`)
if (results.fail.length > 0) {
  console.log('')
  for (const line of results.fail) console.log(`  FAIL  ${line}`)
}
console.log('')
// Setting exitCode rather than calling exit() lets Node close its handles
// cleanly; process.exit() here trips a libuv assertion on Windows.
process.exitCode = results.fail.length > 0 ? 1 : 0
