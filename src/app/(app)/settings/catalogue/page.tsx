import Link from 'next/link'
import { requireTenantAdmin } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui'
import { UploadForm } from './upload-form'
import type { ImportStatus } from '@/lib/db/types'

const STATUS_TONE: Record<ImportStatus, 'neutral' | 'accent' | 'warn' | 'flag' | 'ok'> = {
  uploaded: 'neutral',
  validating: 'neutral',
  previewed: 'warn',
  committing: 'accent',
  committed: 'ok',
  failed: 'flag',
  discarded: 'neutral',
}

const KIND_LABEL = {
  products: 'Catalogue',
  price_rules: 'Price rules',
  customers: 'Customers',
  substitutions: 'Cross-reference',
}

export default async function CataloguePage() {
  const { tenant } = await requireTenantAdmin()
  const supabase = await createClient()

  const [{ data: imports }, { count: productCount }, { count: ruleCount }] = await Promise.all([
    supabase
      .from('catalogue_imports')
      .select('id, kind, status, filename, row_count, valid_count, error_count, diff_summary, created_at, committed_at')
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false })
      .limit(25),
    supabase
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id)
      .eq('is_active', true),
    supabase.from('price_rules').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id),
  ])

  const pending = imports?.find((i) => i.status === 'previewed')

  return (
    <>
      <PageHeader
        title="Catalogue and pricing"
        description="Upload the export from your ERP. Nothing is written until you have seen exactly what would change."
      />

      <div className="mb-6 flex gap-8 text-sm">
        <div>
          <p className="text-ink-faint">Active products</p>
          <p className="nums mt-0.5 text-2xl font-semibold text-ink">
            {(productCount ?? 0).toLocaleString('en-US')}
          </p>
        </div>
        <div>
          <p className="text-ink-faint">Price rules</p>
          <p className="nums mt-0.5 text-2xl font-semibold text-ink">
            {(ruleCount ?? 0).toLocaleString('en-US')}
          </p>
        </div>
      </div>

      {pending && (
        <div className="mb-6 rounded-md border border-warn/25 bg-warn-soft px-3 py-2.5 text-sm text-warn">
          <Link href={`/settings/catalogue/${pending.id}`} className="font-medium underline">
            {pending.filename}
          </Link>{' '}
          is staged and waiting for review. It has not changed anything yet.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        <UploadForm />

        <div>
          <h2 className="mb-2 text-sm font-medium text-ink-soft">Recent imports</h2>
          {!imports || imports.length === 0 ? (
            <EmptyState title="No imports yet">
              <p>Upload a product export to get started.</p>
            </EmptyState>
          ) : (
            <Card className="overflow-hidden">
              <table className="w-full text-sm">
                <thead className="border-b border-line bg-sunken text-left text-micro font-medium tracking-[.13em] text-ink-dim uppercase">
                  <tr>
                    <th className="px-4 py-2.5">File</th>
                    <th className="px-4 py-2.5">Type</th>
                    <th className="px-4 py-2.5">Rows</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5">When</th>
                  </tr>
                </thead>
                <tbody>
                  {imports.map((record) => (
                    <tr key={record.id} className="border-b border-line-soft last:border-0 hover:bg-fill">
                      <td className="px-4 py-2.5">
                        <Link href={`/settings/catalogue/${record.id}`} className="font-medium text-accent hover:underline">
                          {record.filename}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-ink-soft">{KIND_LABEL[record.kind]}</td>
                      <td className="nums px-4 py-2.5 text-ink-soft">
                        {(record.valid_count ?? 0).toLocaleString('en-US')}
                        {record.error_count ? (
                          <span className="ml-1.5 text-flag">+{record.error_count} bad</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={STATUS_TONE[record.status]}>{record.status}</Badge>
                      </td>
                      <td className="nums px-4 py-2.5 text-ink-faint">
                        {new Date(record.created_at).toLocaleDateString('en-US', {
                          month: 'short', day: 'numeric',
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}
