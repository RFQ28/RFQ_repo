/**
 * The intake edges, against a running dev server and the real database.
 *
 * Graph itself cannot be exercised without an Entra app registration, so what
 * is checked here is everything around it — the parts that decide whether an
 * RFQ is accepted, rejected or lost:
 *
 *   - the subscription validation handshake Graph performs before it will
 *     deliver anything at all
 *   - that a forged notification is refused
 *   - that the queue actually drains through the worker endpoint
 *
 *   npm run dev            # in another terminal
 *   node scripts/verify-intake.mjs
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
const base = env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const results = { pass: [], fail: [] }
const ok = (name, detail = '') => results.pass.push(detail ? `${name} — ${detail}` : name)
const bad = (name, detail) => results.fail.push(`${name} — ${detail}`)

try {
  await fetch(`${base}/login`)
} catch {
  console.error(`\n  No server at ${base}. Start it with "npm run dev" and try again.\n`)
  process.exitCode = 1
}

if (process.exitCode !== 1) {
  // --- the handshake Graph performs before it will deliver anything ---------

  const token = `validation-${Date.now()}`
  const handshake = await fetch(`${base}/api/graph/webhook?validationToken=${encodeURIComponent(token)}`, {
    method: 'POST',
  })
  const echoed = await handshake.text()

  if (handshake.status === 200 && echoed === token) {
    ok('validation handshake', 'token echoed as plain text')
  } else {
    bad('validation handshake', `status ${handshake.status}, body "${echoed.slice(0, 40)}"`)
  }

  const contentType = handshake.headers.get('content-type') ?? ''
  if (contentType.includes('text/plain')) ok('validation content type', contentType)
  else bad('validation content type', `Graph requires text/plain, got "${contentType}"`)

  // --- a forged notification must not become an RFQ ------------------------

  const forged = await fetch(`${base}/api/graph/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      value: [{
        subscriptionId: 'sub-that-does-not-exist',
        clientState: 'guessed',
        resourceData: { id: 'AAMkAGm-forged' },
      }],
    }),
  })
  const forgedBody = await forged.json().catch(() => ({}))
  if (forged.status === 202 && forgedBody.queued === 0) {
    ok('forged notification', `refused (${forgedBody.rejected} rejected, nothing queued)`)
  } else {
    bad('forged notification', `status ${forged.status}, body ${JSON.stringify(forgedBody)}`)
  }

  // A real subscription id with the wrong clientState is the more dangerous
  // case: the attacker knows who to impersonate.
  const stamp = Date.now()
  const { data: tenant } = await admin.rpc('provision_tenant', {
    p_slug: `intake-${stamp}`, p_name: 'Intake Check', p_owner_email: null, p_inbound_address: null,
  })

  const { error: connectionError } = await admin.from('mailbox_connections').insert({
    tenant_id: tenant.id,
    method: 'graph',
    mailbox_address: `quotes-${stamp}@example.test`,
    ms_tenant_id: 'common',
    subscription_id: `sub-${stamp}`,
    client_state: 'the-real-secret',
    status: 'connected',
  })
  if (connectionError) bad('seed connection', connectionError.message)

  const wrongState = await fetch(`${base}/api/graph/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      value: [{
        subscriptionId: `sub-${stamp}`,
        clientState: 'wrong-secret',
        resourceData: { id: 'AAMkAGm-forged-2' },
      }],
    }),
  })
  const wrongBody = await wrongState.json().catch(() => ({}))
  if (wrongBody.queued === 0 && wrongBody.rejected === 1) {
    ok('wrong clientState', 'refused on a real subscription id')
  } else {
    bad('wrong clientState', `queued ${wrongBody.queued} — a forged notification was accepted`)
  }

  // --- a genuine notification queues exactly one job -----------------------

  const genuine = await fetch(`${base}/api/graph/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      value: [{
        subscriptionId: `sub-${stamp}`,
        clientState: 'the-real-secret',
        resourceData: { id: `AAMkAGm-${stamp}` },
      }],
    }),
  })
  const genuineBody = await genuine.json().catch(() => ({}))
  if (genuineBody.queued === 1) ok('genuine notification', 'queued one ingest job')
  else bad('genuine notification', `queued ${genuineBody.queued}`)

  // The same message notified twice is one job, not two (6.1).
  await fetch(`${base}/api/graph/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      value: [{
        subscriptionId: `sub-${stamp}`,
        clientState: 'the-real-secret',
        resourceData: { id: `AAMkAGm-${stamp}` },
      }],
    }),
  })

  const { count: jobCount } = await admin
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenant.id)
    .eq('kind', 'ingest_email')

  if (jobCount === 1) ok('duplicate notification', 'the second one did not create a job')
  else bad('duplicate notification', `${jobCount} jobs for one message`)

  // --- the worker endpoint -------------------------------------------------

  const unauthorised = await fetch(`${base}/api/jobs/run`, { method: 'POST' })
  if (unauthorised.status === 401) ok('worker auth', 'refused without a bearer token')
  else bad('worker auth', `status ${unauthorised.status} without a token`)

  const wrongSecret = await fetch(`${base}/api/jobs/run`, {
    method: 'POST',
    headers: { Authorization: 'Bearer not-the-secret' },
  })
  if (wrongSecret.status === 401) ok('worker auth', 'refused a wrong token')
  else bad('worker auth', `status ${wrongSecret.status} with a wrong token`)

  const run = await fetch(`${base}/api/jobs/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WORKER_SECRET}` },
  })
  const runBody = await run.json().catch(() => ({}))

  if (run.status === 200) {
    ok('worker run', `claimed ${runBody.claimed}, succeeded ${runBody.succeeded}, failed ${runBody.failed}`)
  } else {
    bad('worker run', `status ${run.status}: ${JSON.stringify(runBody)}`)
  }

  // The ingest job cannot succeed — there is no real Microsoft behind it — but
  // it must fail into the queue's retry path rather than vanish.
  const { data: job } = await admin
    .from('jobs')
    .select('status, attempts, last_error')
    .eq('tenant_id', tenant.id)
    .eq('kind', 'ingest_email')
    .maybeSingle()

  if (job && job.attempts > 0 && (job.status === 'queued' || job.status === 'dead')) {
    ok('failed job survives', `status ${job.status} after ${job.attempts} attempt(s), error recorded`)
  } else {
    bad('failed job survives', `job is ${JSON.stringify(job)}`)
  }

  await admin.from('tenants').delete().eq('id', tenant.id)
}

console.log(`\n  ${results.pass.length} passed, ${results.fail.length} failed\n`)
for (const line of results.pass) console.log(`  ok    ${line}`)
if (results.fail.length > 0) {
  console.log('')
  for (const line of results.fail) console.log(`  FAIL  ${line}`)
}
console.log('')
if (process.exitCode !== 1) process.exitCode = results.fail.length > 0 ? 1 : 0
