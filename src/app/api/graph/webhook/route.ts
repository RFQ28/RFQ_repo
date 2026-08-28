import { NextResponse, type NextRequest } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { secretsMatch } from '@/lib/crypto/tokens'
import { enqueue } from '@/lib/jobs'

export const dynamic = 'force-dynamic'

/**
 * Graph change notifications (PRD 6.1).
 *
 * Two hard requirements shape this handler:
 *
 *   - **Answer fast.** Graph expects a 2xx within seconds and will retry, then
 *     eventually drop the subscription, if it does not get one. So nothing is
 *     processed here: each notification becomes a queued job and the request
 *     returns.
 *   - **Never lose mail.** Anything that cannot be queued is logged loudly. A
 *     notification we accept and then drop is an RFQ nobody ever sees.
 */

export async function POST(request: NextRequest) {
  // Graph validates a new subscription by calling it with a token to echo back
  // as plain text. This must happen before any other consideration.
  const validationToken = request.nextUrl.searchParams.get('validationToken')
  if (validationToken) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  let payload: { value?: GraphNotification[] }
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Malformed notification' }, { status: 400 })
  }

  const notifications = payload.value ?? []
  if (notifications.length === 0) return new NextResponse(null, { status: 202 })

  const db = adminClient()
  let queued = 0
  let rejected = 0

  for (const notification of notifications) {
    const subscriptionId = notification.subscriptionId
    if (!subscriptionId) {
      rejected += 1
      continue
    }

    const { data: connection } = await db
      .from('mailbox_connections')
      .select('id, tenant_id, client_state, mailbox_address, status')
      .eq('subscription_id', subscriptionId)
      .maybeSingle()

    // A notification for a subscription we do not know about is not ours.
    if (!connection) {
      rejected += 1
      continue
    }

    // clientState is the only thing proving this came from Graph on our behalf
    // and not from anyone who guessed the URL.
    if (
      !connection.client_state ||
      !notification.clientState ||
      !secretsMatch(notification.clientState, connection.client_state)
    ) {
      rejected += 1
      console.error('graph webhook: clientState mismatch', { subscriptionId })
      continue
    }

    const messageId = notification.resourceData?.id
    if (!messageId) {
      rejected += 1
      continue
    }

    try {
      await enqueue('ingest_email', {
        tenantId: connection.tenant_id,
        payload: {
          mailboxConnectionId: connection.id,
          mailbox: connection.mailbox_address,
          graphMessageId: messageId,
        },
        // The same message notified twice becomes one job, and a job already
        // running for it is not duplicated.
        dedupeKey: `ingest_email:${connection.tenant_id}:${messageId}`,
        priority: 10,
      })
      queued += 1
    } catch (error) {
      // Losing this would lose an RFQ. Graph retries on a non-2xx, so the
      // honest answer is to fail the whole batch and let it come again.
      console.error('graph webhook: could not queue', { subscriptionId, messageId, error })
      return NextResponse.json({ error: 'Could not queue notification' }, { status: 500 })
    }
  }

  if (rejected > 0) console.warn(`graph webhook: ignored ${rejected} notification(s)`)

  return NextResponse.json({ queued, rejected }, { status: 202 })
}

/**
 * Graph also sends lifecycle notifications (a subscription about to expire, or
 * one that missed changes) to the same URL by POST; some tenants probe with a
 * GET first. Answering the validation handshake here too costs nothing.
 */
export async function GET(request: NextRequest) {
  const validationToken = request.nextUrl.searchParams.get('validationToken')
  if (validationToken) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })
  }
  return new NextResponse(null, { status: 405 })
}

type GraphNotification = {
  subscriptionId?: string
  clientState?: string
  changeType?: string
  resource?: string
  resourceData?: { id?: string }
}
