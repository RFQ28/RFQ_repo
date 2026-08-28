import Link from 'next/link'
import { requireSession } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui'
import { formatMoney } from '@/lib/utils'
import type { QuoteStatus } from '@/lib/db/types'

const STATUS_TONE: Record<QuoteStatus, 'neutral' | 'ok' | 'warn' | 'flag' | 'accent'> = {
  draft: 'accent',
  in_review: 'warn',
  sent: 'ok',
  won: 'ok',
  lost: 'flag',
  no_response: 'neutral',
  cancelled: 'neutral',
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
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs font-medium tracking-wide text-ink-faint uppercase">
              <tr>
                <th className="px-4 py-2.5">Quote</th>
                <th className="px-4 py-2.5">Job</th>
                <th className="px-4 py-2.5">Contractor</th>
                <th className="px-4 py-2.5 text-right">Value</th>
                <th className="px-4 py-2.5">With</th>
                <th className="px-4 py-2.5">Status</th>
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
                  <tr key={quote.id} className="border-b border-line last:border-0 hover:bg-canvas">
                    <td className="px-4 py-2.5">
                      <Link href={`/quotes/${quote.id}`} className="font-mono text-xs text-accent hover:underline">
                        {quote.quote_number ?? 'draft'}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 font-medium text-ink">{rfq?.job_name ?? 'Untitled'}</td>
                    <td className="px-4 py-2.5 text-ink-soft">
                      {(quote.customers as unknown as { name: string } | null)?.name ?? '—'}
                    </td>
                    <td className="nums px-4 py-2.5 text-right text-ink">
                      {formatMoney(quote.subtotal === null ? null : Number(quote.subtotal))}
                    </td>
                    <td className="px-4 py-2.5 text-ink-faint">
                      {rfq?.users?.full_name ?? rfq?.users?.email ?? '—'}
                    </td>
                    <td className="px-4 py-2.5">
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
