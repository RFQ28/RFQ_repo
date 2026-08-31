/**
 * Removes everything scripts/seed-demo.mjs created.
 *
 * The tenant row cascades to every tenant-scoped table, so this is a delete of
 * the tenant plus the one auth user, which does not cascade from it.
 *
 *   node scripts/unseed-demo.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const SLUG = 'northgate'
const OWNER_EMAIL = 'rep@northgate-demo.test'

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

const db = createClient(url, key, { auth: { persistSession: false } })

const { data: tenant } = await db.from('tenants').select('id, name').eq('slug', SLUG).maybeSingle()
if (tenant) {
  const { error } = await db.from('tenants').delete().eq('id', tenant.id)
  if (error) throw new Error(`delete tenant: ${error.message}`)
  console.log(`removed tenant ${tenant.name}`)
} else {
  console.log('no demo tenant found')
}

const { data: list } = await db.auth.admin.listUsers({ perPage: 200 })
const user = list?.users?.find((u) => u.email?.toLowerCase() === OWNER_EMAIL)
if (user) {
  await db.auth.admin.deleteUser(user.id)
  console.log(`removed auth user ${OWNER_EMAIL}`)
}

await db.from('invitations').delete().eq('email', OWNER_EMAIL)
console.log('done')
