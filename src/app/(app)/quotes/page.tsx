import Link from 'next/link'
import { requireSession } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui'
import { cn, formatMoney } from '@/lib/utils'
import type { QuoteStatus } from '@/lib/db/types'

const STATUS_TONE: Record<QuoteStatus, 'neutral' | 'quiet' | 'ok' | 'warn' | 'flag' | 'accent'> = {
  draft: 'accent',
  in_review: 'warn',
  sent: 'ok',
  won: 'ok',
  lost: 'flag',
  no_response: 'quiet',
  cancelled: 'quiet',
}

export default async function QuotesPage() {
  const { tenant } = await requireSession()
  const supabase = await createClient()

  const { data: quotes } = await supabase
    .from('quotes')
    .select(
      `id, quote_number, status, subtotal, created_at, sent_at,
       customers(name),
       rfqs(job_name, due_date, claimed_by, users:claimed_by(full_name, email))`,
    )
    .eq('tenant_id', tenant.id)
    .order('created_at', { ascending: false })
    .limit(100)

  return (
    <>
      <PageHeader
        title="Quotes"
        description="Drafts waiting on you, and everything already sent."
      />

      {!quotes || quotes.length === 0 ? (
        <EmptyState title="No quotes yet">
          <p>A quote appears here as soon as an RFQ has been matched and priced.</p>
        </EmptyState>
      ) : (
        <Card>
          <table className="w-full">
            <thead>
              <tr className="border-b border-line bg-sunken text-left">
                <Th>Quote</Th>
                <Th>Job</Th>
                <Th>Contractor</Th>
                <Th align="right">Value</Th>
                <Th>With</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((quote) => {
                const rfq = quote.rfqs as unknown as {
                  job_name: string | null
                  due_date: string | null
                  users: { full_name: string | null; email: string } | null
                } | null

                return (
                  <tr
                    key={quote.id}
                    className="border-b border-line-soft transition-colors last:border-0 hover:bg-fill"
                  >
                    <td className="px-5 py-3">
                      <Link
                        href={`/quotes/${quote.id}`}
                        className="font-mono text-xs font-medium text-ink-mid underline-offset-2 hover:text-ink hover:underline"
                      >
                        {quote.quote_number ?? 'draft'}
                      </Link>
                    </td>
                    <td className="px-5 py-3">
                      <Link
                        href={`/quotes/${quote.id}`}
                        className="text-base font-semibold text-ink underline-offset-2 hover:underline"
                      >
                        {rfq?.job_name ?? 'Untitled'}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-sm text-ink-mid">
                      {(quote.customers as unknown as { name: string } | null)?.name ?? '—'}
                    </td>
                    <td className="nums px-5 py-3 text-right font-mono text-base font-semibold text-ink">
                      {formatMoney(quote.subtotal === null ? null : Number(quote.subtotal))}
                    </td>
                    <td className="px-5 py-3 text-sm text-ink-faint">
                      {rfq?.users?.full_name ?? rfq?.users?.email ?? (
                        <span className="text-ink-pale">unclaimed</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={STATUS_TONE[quote.status]}>{quote.status.replace('_', ' ')}</Badge>
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
