import Link from 'next/link'
import { requireSession } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui'
import type { RfqStatus } from '@/lib/db/types'

const STATUS_TONE: Record<RfqStatus, 'neutral' | 'accent' | 'warn' | 'flag' | 'ok'> = {
  received: 'neutral',
  parsing: 'neutral',
  matching: 'neutral',
  draft_ready: 'accent',
  in_review: 'warn',
  quoted: 'ok',
  ignored: 'neutral',
  failed: 'flag',
}

const STATUS_LABEL: Record<RfqStatus, string> = {
  received: 'Received',
  parsing: 'Parsing',
  matching: 'Matching',
  draft_ready: 'Draft ready',
  in_review: 'In review',
  quoted: 'Quoted',
  ignored: 'Ignored',
  failed: 'Failed',
}

export default async function RfqsPage() {
  const { tenant } = await requireSession()
  const supabase = await createClient()

  // RLS scopes this to the caller's tenant; the filter is belt and braces.
  const { data: rfqs } = await supabase
    .from('rfqs')
    .select('id, status, job_name, contractor_name, due_date, received_at, claimed_by, customers(name), quotes(id)')
    .eq('tenant_id', tenant.id)
    .neq('classification', 'not_rfq')
    .order('received_at', { ascending: false })
    .limit(100)

  return (
    <>
      <PageHeader
        title="RFQs"
        description="Everything that came into the quotes inbox, newest first. Drafts appear here on their own — nobody forwards anything."
      />

      {!rfqs || rfqs.length === 0 ? (
        <EmptyState title="Nothing in the queue yet">
          <p>
            Connect the shared quotes mailbox and RFQs will land here within a few minutes of arriving.
          </p>
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs font-medium tracking-wide text-ink-faint uppercase">
              <tr>
                <th className="px-4 py-2.5">Job</th>
                <th className="px-4 py-2.5">Contractor</th>
                <th className="px-4 py-2.5">Received</th>
                <th className="px-4 py-2.5">Due</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {rfqs.map((rfq) => (
                <tr key={rfq.id} className="border-b border-line last:border-0 hover:bg-canvas">
                  <td className="px-4 py-2.5 font-medium text-ink">
                    {(() => {
                      const quote = (rfq.quotes as unknown as { id: string }[])?.[0]
                      return quote ? (
                        <Link href={`/quotes/${quote.id}`} className="text-accent hover:underline">
                          {rfq.job_name ?? 'Untitled'}
                        </Link>
                      ) : (
                        (rfq.job_name ?? 'Untitled')
                      )
                    })()}
                  </td>
                  <td className="px-4 py-2.5 text-ink-soft">
                    {(rfq.customers as { name: string } | null)?.name ?? rfq.contractor_name ?? '—'}
                  </td>
                  <td className="nums px-4 py-2.5 text-ink-soft">
                    {new Date(rfq.received_at).toLocaleString('en-US', {
                      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                    })}
                  </td>
                  <td className="nums px-4 py-2.5 text-ink-soft">{rfq.due_date ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={STATUS_TONE[rfq.status]}>{STATUS_LABEL[rfq.status]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  )
}
