'use server'

import { randomBytes } from 'node:crypto'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireTenantAdmin } from '@/lib/auth/session'
import { adminClient } from '@/lib/supabase/admin'
import { encryptionAvailable } from '@/lib/crypto/tokens'
import { authorizeUrl, deleteSubscription, accessTokenFor, graphConfigured } from '@/lib/graph/client'
import type { MailboxConnectionRow } from '@/lib/db/types'

export type MailboxActionState = { error?: string; message?: string }

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * Starts the Microsoft consent flow for a shared mailbox (PRD 6.1).
 *
 * The owner authorises once. Nothing here asks a rep for anything, and no
 * mailbox access is requested at sign-in — only at this deliberate step.
 */
export async function connectMailbox(
  _prev: MailboxActionState,
  formData: FormData,
): Promise<MailboxActionState> {
  const { tenant } = await requireTenantAdmin()

  if (!graphConfigured()) {
    return { error: 'Microsoft Graph is not configured on this deployment. Set the MS_* values first.' }
  }
  if (!encryptionAvailable()) {
    return {
      error:
        'TOKEN_ENCRYPTION_KEY is not set, and mailbox tokens are not stored unencrypted. ' +
        'Set it before connecting a mailbox.',
    }
  }

  const mailbox = String(formData.get('mailbox') ?? '').trim().toLowerCase()
  const msTenant = String(formData.get('ms_tenant') ?? '').trim() || 'common'

  if (!EMAIL_RE.test(mailbox)) return { error: 'Enter the shared mailbox address, e.g. quotes@distributor.com' }

  const db = adminClient()
  const state = randomBytes(32).toString('base64url')

  const { data: existing } = await db
    .from('mailbox_connections')
    .select('id')
    .eq('tenant_id', tenant.id)
    .eq('method', 'graph')
    .maybeSingle()

  if (existing) {
    await db
      .from('mailbox_connections')
      .update({ mailbox_address: mailbox, ms_tenant_id: msTenant, client_state: state })
      .eq('id', existing.id)
  } else {
    const { error } = await db.from('mailbox_connections').insert({
      tenant_id: tenant.id,
      method: 'graph',
      mailbox_address: mailbox,
      ms_tenant_id: msTenant,
      client_state: state,
      status: 'disconnected',
    })
    if (error) return { error: error.message }
  }

  redirect(authorizeUrl(state, msTenant))
}

/** Stops watching a mailbox and destroys the stored tokens. */
export async function disconnectMailbox(): Promise<MailboxActionState> {
  const { tenant, user } = await requireTenantAdmin()
  const db = adminClient()

  const { data: connection } = await db
    .from('mailbox_connections')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('method', 'graph')
    .maybeSingle()

  if (!connection) return { error: 'There is no mailbox connected.' }

  // Best effort: a subscription left behind would keep notifying a webhook
  // that no longer has tokens to act on it.
  if (connection.subscription_id) {
    try {
      const token = await accessTokenFor(connection as MailboxConnectionRow)
      await deleteSubscription(token, connection.subscription_id)
    } catch {
      // Already revoked, or the tokens are gone. Clearing our side is what matters.
    }
  }

  await db
    .from('mailbox_connections')
    .update({
      access_token_enc: null,
      refresh_token_enc: null,
      token_expires_at: null,
      subscription_id: null,
      subscription_expires_at: null,
      client_state: null,
      status: 'disconnected',
      last_error: null,
    })
    .eq('id', connection.id)

  await db.from('activity_log').insert({
    tenant_id: tenant.id,
    actor_id: user.id,
    actor_kind: 'user',
    entity_type: 'mailbox_connection',
    entity_id: connection.id,
    action: 'mailbox.disconnected',
    detail: { mailbox: connection.mailbox_address },
  })

  revalidatePath('/settings/mailbox')
  return { message: 'Disconnected. No further mail will be read from that mailbox.' }
}

/**
 * The forwarding fallback (6.1), for an owner who will not grant mailbox
 * access. Their IT sets one server-side rule copying the quotes inbox here.
 */
export async function useForwardingAddress(
  _prev: MailboxActionState,
  formData: FormData,
): Promise<MailboxActionState> {
  const { tenant } = await requireTenantAdmin()

  const mailbox = String(formData.get('mailbox') ?? '').trim().toLowerCase()
  if (!EMAIL_RE.test(mailbox)) return { error: 'Enter the mailbox their rule will forward from.' }

  const inbound = `tenant-${tenant.slug}@inbound.vmsa.app`
  const db = adminClient()

  const { data: existing } = await db
    .from('mailbox_connections')
    .select('id')
    .eq('tenant_id', tenant.id)
    .eq('method', 'forwarding')
    .maybeSingle()

  if (existing) {
    await db
      .from('mailbox_connections')
      .update({ mailbox_address: mailbox, inbound_address: inbound, status: 'connected' })
      .eq('id', existing.id)
  } else {
    const { error } = await db.from('mailbox_connections').insert({
      tenant_id: tenant.id,
      method: 'forwarding',
      mailbox_address: mailbox,
      inbound_address: inbound,
      status: 'connected',
    })
    if (error) return { error: error.message }
  }

  revalidatePath('/settings/mailbox')
  return { message: `Ask their IT to forward ${mailbox} to ${inbound}.` }
}
