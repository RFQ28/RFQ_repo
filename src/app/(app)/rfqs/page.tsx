import Link from 'next/link'
import { requireSession } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui'
import { dueRelative } from '@/lib/quote/triage'
import { cn } from '@/lib/utils'
import type { RfqStatus } from '@/lib/db/types'

const STATUS_TONE: Record<RfqStatus, 'neutral' | 'quiet' | 'accent' | 'warn' | 'flag' | 'ok'> = {
  received: 'quiet',
  parsing: 'quiet',
  matching: 'quiet',
  draft_ready: 'accent',
  in_review: 'warn',
  quoted: 'ok',
  ignored: 'quiet',
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
        <Card>
          <table className="w-full">
            <thead>
              <tr className="border-b border-line bg-sunken text-left">
                <Th>Job</Th>
                <Th>Contractor</Th>
                <Th>Received</Th>
                <Th>Due</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {rfqs.map((rfq) => {
                const quote = (rfq.quotes as unknown as { id: string }[])?.[0]
                const left = dueRelative(rfq.due_date)
                const pressing = left !== null && (left.endsWith('late') || left === 'due today')

                return (
                  <tr
                    key={rfq.id}
                    className="border-b border-line-soft transition-colors last:border-0 hover:bg-fill"
                  >
                    <td className="px-5 py-3">
                      {quote ? (
                        <Link
                          href={`/quotes/${quote.id}`}
                          className="text-base font-semibold text-ink underline-offset-2 hover:underline"
                        >
                          {rfq.job_name ?? 'Untitled'}
                        </Link>
                      ) : (
                        <span className="text-base font-semibold text-ink">
                          {rfq.job_name ?? 'Untitled'}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-sm text-ink-mid">
                      {(rfq.customers as { name: string } | null)?.name ?? rfq.contractor_name ?? '—'}
                    </td>
                    <td className="nums px-5 py-3 font-mono text-xs text-ink-faint">
                      {new Date(rfq.received_at).toLocaleString('en-US', {
                        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                      })}
                    </td>
                    <td className="px-5 py-3">
                      {rfq.due_date ? (
                        <>
                          <span className="nums font-mono text-xs text-ink-mid">{rfq.due_date}</span>
                          {left && (
                            <span className={cn('ml-2 text-xs', pressing ? 'text-review' : 'text-ink-dim')}>
                              {left}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-ink-pale">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={STATUS_TONE[rfq.status]}>{STATUS_LABEL[rfq.status]}</Badge>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  )
}

function Th({ children, align }: { children: React.ReactNode; align?: 'right' }) {
  return (
    <th
      className={cn(
        'px-5 py-3 text-micro font-medium tracking-[.13em] text-ink-dim uppercase',
        align === 'right' && 'text-right',
      )}
    >
      {children}
    </th>
  )
}
