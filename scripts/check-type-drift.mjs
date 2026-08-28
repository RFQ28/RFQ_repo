/**
 * Compares src/lib/db/types.ts against the live schema.
 *
 * The types are hand-authored (there is no Supabase CLI here to generate them),
 * so the risk is drift: a column that exists in the database and not in the
 * types is invisible to the application, and a column in the types that does
 * not exist is a runtime error waiting for the first row that touches it.
 *
 * The live column list comes from PostgREST's own OpenAPI document, which is
 * exactly what the client library talks to.
 *
 *   node scripts/check-type-drift.mjs
 */

import { readFileSync } from 'node:fs'

function loadEnv(file) {
  const out = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match) out[match[1]] = match[2].trim()
  }
  return out
}

const env = loadEnv(new URL('../.env.local', import.meta.url))
const source = readFileSync(new URL('../src/lib/db/types.ts', import.meta.url), 'utf8')

const response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
  headers: {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: 'application/openapi+json',
  },
})

if (!response.ok) {
  console.error(`Could not read the API schema: ${response.status} ${response.statusText}`)
  process.exit(1)
}

const spec = await response.json()

/** Maps a table name to the Row type that describes it in types.ts. */
const ROW_TYPES = {
  tenants: 'TenantRow', users: 'UserRow', invitations: 'InvitationRow',
  customers: 'CustomerRow', customer_identifiers: 'CustomerIdentifierRow',
  products: 'ProductRow', price_rules: 'PriceRuleRow',
  uom_conversions: 'UomConversionRow', uom_aliases: 'UomAliasRow',
  substitution_map: 'SubstitutionRow', mailbox_connections: 'MailboxConnectionRow',
  inbound_emails: 'InboundEmailRow', email_attachments: 'EmailAttachmentRow',
  rfqs: 'RfqRow', classification_log: 'ClassificationLogRow', rfq_lines: 'RfqLineRow',
  quotes: 'QuoteRow', quote_lines: 'QuoteLineRow', corrections: 'CorrectionRow',
  activity_log: 'ActivityLogRow', llm_calls: 'LlmCallRow',
  catalogue_imports: 'CatalogueImportRow', catalogue_import_rows: 'CatalogueImportRowRow',
  jobs: 'JobRow', notifications: 'NotificationRow',
}

/** Pulls the field names out of one `export type X = { ... }` block. */
function fieldsOf(typeName) {
  const start = source.indexOf(`export type ${typeName} = {`)
  if (start === -1) return null
  const end = source.indexOf('\n}', start)
  const body = source.slice(start, end)
  return new Set(
    [...body.matchAll(/^\s{2}([a-z_][a-z0-9_]*)\??:/gim)].map((match) => match[1]),
  )
}

let problems = 0
let checked = 0

for (const [table, typeName] of Object.entries(ROW_TYPES)) {
  const definition = spec.definitions?.[table]
  if (!definition) {
    console.log(`  ?     ${table} — not in the API schema`)
    problems += 1
    continue
  }

  const live = new Set(Object.keys(definition.properties ?? {}))
  const declared = fieldsOf(typeName)

  if (!declared) {
    console.log(`  FAIL  ${table} — no ${typeName} in types.ts`)
    problems += 1
    continue
  }

  const missing = [...live].filter((column) => !declared.has(column))
  const extra = [...declared].filter((field) => !live.has(field))

  checked += 1
  if (missing.length === 0 && extra.length === 0) continue

  problems += 1
  console.log(`  FAIL  ${table}`)
  if (missing.length > 0) console.log(`          in the database, not in ${typeName}: ${missing.join(', ')}`)
  if (extra.length > 0) console.log(`          in ${typeName}, not in the database: ${extra.join(', ')}`)
}

// Tables the database has that the application does not model at all.
const modelled = new Set(Object.keys(ROW_TYPES))
const liveTables = Object.keys(spec.definitions ?? {}).filter((name) => !name.startsWith('('))
const unmodelled = liveTables.filter((name) => !modelled.has(name))
if (unmodelled.length > 0) {
  console.log(`  note  tables in the database with no Row type: ${unmodelled.join(', ')}`)
}

console.log(
  problems === 0
    ? `\n  ${checked} tables match the live schema.\n`
    : `\n  ${checked} checked, ${problems} with drift.\n`,
)
// See the note in verify-schema.mjs about exitCode over exit().
process.exitCode = problems > 0 ? 1 : 0
