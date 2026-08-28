import 'server-only'

import type { MailboxConnectionRow } from '@/lib/db/types'
import { adminClient } from '@/lib/supabase/admin'
import { tenantDb } from '@/lib/supabase/tenant'
import {
  accessTokenFor, createSubscription, listRecentMessages, renewSubscription,
  RENEW_WHEN_WITHIN_MINUTES, GraphError,
} from '@/lib/graph/client'
import { clientEnv } from '@/lib/env'
import { enqueue } from '../queue'

/**
 * Keeps mailbox subscriptions alive, and catches up on anything missed.
 *
 * PRD 6.1: "Graph subscriptions expire — auto-renew before expiry, alert admin
 * on failure." A subscription that lapses does not announce itself; the inbox
 * simply goes quiet, and a distributor's RFQs pile up unquoted while everything
 * looks healthy. So this both renews and sweeps: every run also asks Graph
 * directly for recent messages, so a webhook lost to a deploy or an outage is
 * picked up on the next pass rather than never.
 *
 * Run it on a schedule, every few hours.
 */
// Takes no payload: it sweeps every graph connection the tenant table has.
export async function renewSubscriptions(): Promise<void> {
  const db = adminClient()

  const { data: connections, error } = await db
    .from('mailbox_connections')
    .select('*')
    .eq('method', 'graph')
    .neq('status', 'disconnected')

  if (error) throw new Error(`Could not list mailbox connections: ${error.message}`)

  const failures: string[] = []

  for (const row of (connections ?? []) as MailboxConnectionRow[]) {
    try {
      await renewOne(row)
      await catchUp(row)
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown)
      failures.push(`${row.mailbox_address}: ${message}`)

      await db
        .from('mailbox_connections')
        .update({
          status: thrown instanceof GraphError && thrown.status === 401 ? 'error' : 'degraded',
          last_error: message,
          last_error_at: new Date().toISOString(),
        })
        .eq('id', row.id)

      // One alert per connection per day. The owner does not need to be told
      // hourly that the same mailbox is still disconnected.
      await db.from('notifications').insert({
        tenant_id: row.tenant_id,
        kind: 'mailbox_error',
        channel: 'email',
        subject: `The quotes mailbox ${row.mailbox_address} needs attention`,
        body:
          `We could not keep watching ${row.mailbox_address}.\n\n${message}\n\n` +
          'RFQs arriving now may not be picked up until this is reconnected.',
        dedupe_key: `mailbox_error:${row.id}:${new Date().toISOString().slice(0, 10)}`,
      })
    }
  }

  // The job fails as a whole so the queue's backoff and dead-lettering apply,
  // but only after every connection has been attempted.
  if (failures.length > 0) {
    throw new Error(`${failures.length} mailbox(es) could not be renewed: ${failures.join('; ')}`)
  }
}

async function renewOne(connection: MailboxConnectionRow): Promise<void> {
  const db = adminClient()
  const token = await accessTokenFor(connection)

  const expiresAt = connection.subscription_expires_at
    ? new Date(connection.subscription_expires_at).getTime()
    : 0
  const dueWithin = Date.now() + RENEW_WHEN_WITHIN_MINUTES * 60_000

  if (connection.subscription_id && expiresAt > dueWithin) {
    await db
      .from('mailbox_connections')
      .update({ status: 'connected', last_ok_at: new Date().toISOString(), last_error: null })
      .eq('id', connection.id)
    return
  }

  const notificationUrl = `${clientEnv().NEXT_PUBLIC_APP_URL}/api/graph/webhook`

  // An expired subscription cannot be renewed, only replaced — Graph rejects a
  // PATCH once it has lapsed, so a failed renewal falls through to a new one.
  let subscription = null
  if (connection.subscription_id && expiresAt > Date.now()) {
    try {
      subscription = await renewSubscription(token, connection.subscription_id)
    } catch (error) {
      if (!(error instanceof GraphError) || error.status < 400 || error.status >= 500) throw error
    }
  }

  if (!subscription) {
    if (!connection.client_state) {
      throw new Error('This connection has no client state — it needs reconnecting')
    }
    subscription = await createSubscription(token, {
      mailbox: connection.mailbox_address,
      notificationUrl,
      clientState: connection.client_state,
    })
  }

  await db
    .from('mailbox_connections')
    .update({
      subscription_id: subscription.id,
      subscription_expires_at: subscription.expirationDateTime,
      status: 'connected',
      last_ok_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', connection.id)
}

/**
 * Asks Graph for anything that arrived recently and queues whatever we have no
 * record of. This is the safety net under the webhook.
 */
async function catchUp(connection: MailboxConnectionRow): Promise<void> {
  const token = await accessTokenFor(connection)
  const since = new Date(Date.now() - 24 * 3600_000)

  const messages = await listRecentMessages(token, connection.mailbox_address, since)
  if (messages.length === 0) return

  const db = tenantDb(connection.tenant_id)
  const { data: known } = await db
    .from('inbound_emails')
    .select('graph_message_id')
    .gte('received_at', since.toISOString())

  const seen = new Set((known ?? []).map((row) => row.graph_message_id).filter(Boolean))

  let missed = 0
  for (const message of messages) {
    if (seen.has(message.id)) continue
    await enqueue('ingest_email', {
      tenantId: connection.tenant_id,
      payload: {
        mailboxConnectionId: connection.id,
        mailbox: connection.mailbox_address,
        graphMessageId: message.id,
      },
      dedupeKey: `ingest_email:${connection.tenant_id}:${message.id}`,
      priority: 30,
    })
    missed += 1
  }

  if (missed > 0) {
    await db.log({
      action: 'mailbox.catch_up',
      entityType: 'mailbox_connection',
      entityId: connection.id,
      detail: { queued: missed, since: since.toISOString() },
    })
  }
}
