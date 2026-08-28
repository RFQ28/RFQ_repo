import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireTenantAdmin } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'
import { Badge, Callout, Card, PageHeader } from '@/components/ui'
import { FIELD_SPECS, missingRequired } from '@/lib/ingest/mapping'
import type { CatalogueImportDiff, ImportKind } from '@/lib/db/types'
import { ImportControls } from './import-controls'

const ROW_SAMPLE = 200

export default async function ImportPreviewPage({
  params,
}: {
  params: Promise<{ importId: string }>
}) {
  const { importId } = await params
  const { tenant } = await requireTenantAdmin()
  const supabase = await createClient()

  const { data: record } = await supabase
    .from('catalogue_imports')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('id', importId)
    .maybeSingle()

  if (!record) notFound()

  // Bad rows first: they are the only ones anyone needs to act on.
  const [{ data: badRows }, { data: sampleRows }] = await Promise.all([
    supabase
      .from('catalogue_import_rows')
      .select('row_number, raw, errors, warnings')
      .eq('import_id', importId)
      .eq('is_valid', false)
      .order('row_number')
      .limit(ROW_SAMPLE),
    supabase
      .from('catalogue_import_rows')
      .select('row_number, normalized, diff_action, diff_fields, warnings')
      .eq('import_id', importId)
      .eq('is_valid', true)
      .neq('diff_action', 'unchanged')
      .order('row_number')
      .limit(ROW_SAMPLE),
  ])

  const kind = record.kind as ImportKind
  const mapping = (record.column_mapping ?? {}) as Record<string, string>
  const diff = (record.diff_summary ?? null) as CatalogueImportDiff | null
  const missing = missingRequired(mapping, kind)

  // Header names come from the staged rows, so remapping needs no re-upload.
  const headers = Object.keys((badRows?.[0]?.raw ?? {}) as object).length
    ? Object.keys(badRows![0].raw as object)
    : Object.values(mapping)

  const committed = record.status === 'committed'

  return (
    <>
      <PageHeader
        title={record.filename}
        description={
          <>
            <Link href="/settings/catalogue" className="text-accent hover:underline">
              Catalogue
            </Link>
            <span className="mx-1.5 text-ink-faint">/</span>
            {record.row_count?.toLocaleString('en-US') ?? 0} rows read
            {record.error_count ? `, ${record.error_count} could not be used` : ''}
          </>
        }
        actions={<Badge tone={committed ? 'ok' : 'warn'}>{record.status}</Badge>}
      />

      {record.error && (
        <div className="mb-6">
          <Callout tone="flag" title="This import failed">
            {record.error}
          </Callout>
        </div>
      )}

      {missing.length > 0 && !committed && (
        <div className="mb-6">
          <Callout tone="flag" title="Required columns are not mapped">
            <ul className="mt-1 list-inside list-disc">
              {missing.map((m) => (
                <li key={m.field}>{m.message}</li>
              ))}
            </ul>
          </Callout>
        </div>
      )}

      {diff && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="New" value={diff.created} tone="accent" />
          <Stat label="Updated" value={diff.updated} tone="warn" />
          <Stat label="Unchanged" value={diff.unchanged} />
          <Stat label="Price changes" value={diff.price_changes} tone={diff.price_changes ? 'warn' : 'neutral'} />
          <Stat label="Deactivated" value={diff.deactivated} tone={diff.deactivated ? 'flag' : 'neutral'} />
        </div>
      )}

      <ImportControls
        importId={record.id}
        kind={kind}
        mapping={mapping}
        headers={headers}
        fields={FIELD_SPECS[kind]}
        deactivateMissing={record.deactivate_missing}
        status={record.status}
        blocked={missing.length > 0}
      />

      {badRows && badRows.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-medium text-ink">
            Rows that will be left out ({record.error_count?.toLocaleString('en-US')})
          </h2>
          <p className="mb-3 text-sm text-ink-soft">
            These are not written. Fix them in the export and upload again, or accept the gap knowingly.
          </p>
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs font-medium tracking-wide text-ink-faint uppercase">
                <tr>
                  <th className="w-16 px-4 py-2.5">Row</th>
                  <th className="px-4 py-2.5">Problem</th>
                  <th className="px-4 py-2.5">Source</th>
                </tr>
              </thead>
              <tbody>
                {badRows.map((row) => (
                  <tr key={row.row_number} className="border-b border-line last:border-0 align-top">
                    <td className="nums px-4 py-2.5 text-ink-faint">{row.row_number}</td>
                    <td className="px-4 py-2.5 text-flag">{row.errors.join('; ')}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-faint">
                      {Object.values(row.raw as Record<string, string>)
                        .filter(Boolean)
                        .slice(0, 6)
                        .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      )}

      {sampleRows && sampleRows.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-medium text-ink">What would change</h2>
          <p className="mb-3 text-sm text-ink-soft">
            First {Math.min(ROW_SAMPLE, sampleRows.length)} rows that create or alter something.
          </p>
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs font-medium tracking-wide text-ink-faint uppercase">
                <tr>
                  <th className="w-16 px-4 py-2.5">Row</th>
                  <th className="w-24 px-4 py-2.5">Action</th>
                  <th className="px-4 py-2.5">Key</th>
                  <th className="px-4 py-2.5">Changes</th>
                </tr>
              </thead>
              <tbody>
                {sampleRows.map((row) => {
                  const normalized = (row.normalized ?? {}) as Record<string, unknown>
                  const changes = (row.diff_fields ?? {}) as Record<string, { from: unknown; to: unknown }>
                  return (
                    <tr key={row.row_number} className="border-b border-line last:border-0 align-top">
                      <td className="nums px-4 py-2.5 text-ink-faint">{row.row_number}</td>
                      <td className="px-4 py-2.5">
                        <Badge tone={row.diff_action === 'create' ? 'accent' : 'warn'}>
                          {row.diff_action}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink">
                        {String(normalized.sku ?? normalized.external_id ?? normalized.requested_part_number ?? normalized.customer_external_id ?? normalized.customer_name ?? '—')}
                      </td>
                      <td className="px-4 py-2.5 text-ink-soft">
                        {row.diff_action === 'create' ? (
                          <span className="text-ink-faint">
                            {String(normalized.description ?? normalized.name ?? '')}
                          </span>
                        ) : (
                          <ul className="space-y-0.5">
                            {Object.entries(changes).map(([field, change]) => (
                              <li key={field} className="nums">
                                <span className="text-ink-faint">{field}</span>{' '}
                                <span className="line-through opacity-60">{String(change.from ?? '—')}</span>{' '}
                                <span aria-hidden>→</span>{' '}
                                <span className="font-medium text-ink">{String(change.to ?? '—')}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {row.warnings.length > 0 && (
                          <p className="mt-1 text-xs text-warn">{row.warnings.join('; ')}</p>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Card>
        </section>
      )}
    </>
  )
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: number
  tone?: 'neutral' | 'accent' | 'warn' | 'flag'
}) {
  return (
    <Card className="px-3 py-2.5">
      <p className="text-xs text-ink-faint">{label}</p>
      <p
        className={
          'nums mt-0.5 text-xl font-semibold ' +
          (tone === 'accent' ? 'text-accent' : tone === 'warn' ? 'text-warn' : tone === 'flag' ? 'text-flag' : 'text-ink')
        }
      >
        {value.toLocaleString('en-US')}
      </p>
    </Card>
  )
}
