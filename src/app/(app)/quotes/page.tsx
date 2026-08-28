import { requireSession } from '@/lib/auth/session'
import { EmptyState, PageHeader } from '@/components/ui'

export default async function QuotesPage() {
  await requireSession()

  return (
    <>
      <PageHeader
        title="Quotes"
        description="Drafts you are working, and everything already sent."
      />
      <EmptyState title="No quotes yet">
        <p>Quotes appear here once an RFQ has been matched and priced.</p>
      </EmptyState>
    </>
  )
}
