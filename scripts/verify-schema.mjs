/**
 * Checks the live database against what the migrations were supposed to create.
 *
 * Deliberately goes through PostgREST with the same two keys the application
 * uses, rather than reading catalog tables: that way a table that exists but is
 * unreachable, or an RPC that exists but is not exposed, still fails here.
 *
 *   node scripts/verify-schema.mjs
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
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !anonKey || !serviceKey) {
  console.error('Missing Supabase credentials in .env.local')
  process.exit(1)
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
const anon = createClient(url, anonKey, { auth: { persistSession: false } })

const TABLES = [
  'tenants', 'users', 'invitations',
  'customers', 'customer_identifiers', 'products', 'product_embeddings',
  'price_rules', 'uom_conversions', 'uom_aliases', 'substitution_map',
  'mailbox_connections', 'inbound_emails', 'email_attachments',
  'rfqs', 'classification_log', 'rfq_lines',
  'quotes', 'quote_lines', 'corrections', 'activity_log', 'llm_calls',
  'catalogue_imports', 'catalogue_import_rows', 'jobs', 'notifications',
]

const BUCKETS = ['rfq-attachments', 'quote-pdfs', 'catalogue-imports', 'tenant-branding']

const results = { pass: [], fail: [] }
const ok = (name, detail = '') => results.pass.push(detail ? `${name} — ${detail}` : name)
const bad = (name, detail) => results.fail.push(`${name} — ${detail}`)

// --- tables reachable by the service role ----------------------------------

for (const table of TABLES) {
  const { error } = await admin.from(table).select('*', { count: 'exact', head: true })
  if (error) bad(`table ${table}`, error.message)
  else ok(`table ${table}`)
}

// --- RLS actually blocks an anonymous caller -------------------------------
//
// The whole isolation argument rests on this. An anon client must see nothing
// in a tenant-scoped table, whatever it asks for.

for (const table of ['products', 'quotes', 'quote_lines', 'corrections', 'rfqs', 'price_rules']) {
  const { data, error } = await anon.from(table).select('id').limit(1)
  if (error) ok(`rls ${table}`, `anon refused (${error.code ?? 'error'})`)
  else if ((data ?? []).length === 0) ok(`rls ${table}`, 'anon sees no rows')
  else bad(`rls ${table}`, `anon read ${data.length} row(s) — POLICY LEAK`)
}

// --- RPCs exposed and callable ---------------------------------------------

const rpcChecks = [
  ['provision_tenant', { p_slug: '__verify__', p_name: 'x' }, 'service'],
  ['claim_jobs', { worker_id: '__verify__', batch_size: 0 }, 'service'],
  ['next_quote_number', { target_tenant: '00000000-0000-0000-0000-000000000000' }, 'service'],
  ['search_products_text', { target_tenant: '00000000-0000-0000-0000-000000000000', query: 'x' }, 'service'],
  ['find_corrections', {
    target_tenant: '00000000-0000-0000-0000-000000000000',
    target_customer: null,
    raw_normalized: 'x',
  }, 'service'],
]

for (const [name, args] of rpcChecks) {
  // `provision_tenant` would really create a tenant, so it is only probed for
  // existence by deliberately calling it inside a transaction we cannot roll
  // back — instead, check the signature error rather than the effect.
  if (name === 'provision_tenant') {
    const { error } = await admin.rpc(name, { p_slug: null, p_name: null })
    if (error && /does not exist|not find/i.test(error.message)) bad(`rpc ${name}`, error.message)
    else ok(`rpc ${name}`, 'exposed')
    continue
  }

  const { error } = await admin.rpc(name, args)
  if (error && /does not exist|could not find|not find/i.test(error.message)) {
    bad(`rpc ${name}`, error.message)
  } else if (error) {
    ok(`rpc ${name}`, `exposed (ran with: ${error.message.slice(0, 60)})`)
  } else {
    ok(`rpc ${name}`, 'exposed')
  }
}

// The queue functions must NOT be callable by an anonymous session.
for (const name of ['claim_jobs', 'provision_tenant']) {
  const { error } = await anon.rpc(name, name === 'claim_jobs'
    ? { worker_id: 'x', batch_size: 0 }
    : { p_slug: 'x', p_name: 'x' })
  if (error) ok(`rpc ${name} locked`, 'anon refused')
  else bad(`rpc ${name} locked`, 'anon could call it — PRIVILEGE LEAK')
}

// --- storage buckets --------------------------------------------------------

const { data: buckets, error: bucketError } = await admin.storage.listBuckets()
if (bucketError) {
  bad('storage', bucketError.message)
} else {
  const names = new Set((buckets ?? []).map((b) => b.name))
  for (const bucket of BUCKETS) {
    if (names.has(bucket)) ok(`bucket ${bucket}`)
    else bad(`bucket ${bucket}`, 'missing')
  }
  for (const bucket of buckets ?? []) {
    if (BUCKETS.includes(bucket.name) && bucket.public) {
      bad(`bucket ${bucket.name}`, 'is PUBLIC — attachments would be world-readable')
    }
  }
}

// --- enums round-trip -------------------------------------------------------

const { error: enumError } = await admin.from('rfqs').select('id').eq('status', 'draft_ready').limit(1)
if (enumError) bad('enum rfq_status', enumError.message)
else ok('enum rfq_status')

// --- report -----------------------------------------------------------------

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
