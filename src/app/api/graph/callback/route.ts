import { randomBytes } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { requireTenantAdmin } from '@/lib/auth/session'
import { adminClient } from '@/lib/supabase/admin'
import { encryptToken, secretsMatch } from '@/lib/crypto/tokens'
import { clientEnv } from '@/lib/env'
import { createSubscription, exchangeCode, GraphError } from '@/lib/graph/client'
import { enqueue } from '@/lib/jobs'

export const dynamic = 'force-dynamic'

/**
 * Where Microsoft returns an owner after they authorise the shared mailbox.
 *
 * Exchanges the code, stores the tokens encrypted, and starts the subscription
 * in one pass — an owner who authorises and then finds nothing is watching
 * their inbox has been told the job is done when it is not.
 */
export async function GET(request: NextRequest) {
  // Back to the origin the admin actually came in on, not to the configured
  // app URL. These are the same in production and deliberately different in
  // development, where the browser works against localhost while
  // NEXT_PUBLIC_APP_URL has to be a public HTTPS host for Graph to reach the
  // webhook at all. Redirecting to the configured URL sent an admin who had
  // just consented to a host they had no session cookie on, so a connection
  // that had in fact succeeded showed them a login page.
  //
  // The subscription's notificationUrl below still uses NEXT_PUBLIC_APP_URL:
  // that one is Microsoft calling us, and it must be the public address.
  const settings = new URL('/settings/mailbox', request.nextUrl.origin)

  const error = request.nextUrl.searchParams.get('error')
  if (error) {
    settings.searchParams.set(
      'error',
      request.nextUrl.searchParams.get('error_description') ?? error,
    )
    return NextResponse.redirect(settings)
  }

  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')
  if (!code || !state) {
    settings.searchParams.set('error', 'Microsoft did not return an authorisation code.')
    return NextResponse.redirect(settings)
  }

  // The session is re-checked here rather than trusted from `state` alone: the
  // callback is a public URL, and only a tenant admin may connect a mailbox.
  const { tenant, user } = await requireTenantAdmin()
  const db = adminClient()

  const { data: connection } = await db
    .from('mailbox_connections')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('method', 'graph')
    .maybeSingle()

  // `state` proves this callback belongs to the request we started, not to one
  // someone else induced this admin's browser to make.
  if (!connection?.client_state || !secretsMatch(state, connection.client_state)) {
    settings.searchParams.set('error', 'That sign-in did not match the one that was started. Try again.')
    return NextResponse.redirect(settings)
  }

  try {
    const tokens = await exchangeCode(code, connection.ms_tenant_id ?? 'common')

    // A fresh client state for the subscription itself, so the value that goes
    // out in the authorize URL is not the value Graph echoes to our webhook.
    const webhookState = randomBytes(32).toString('base64url')

    await db
      .from('mailbox_connections')
      .update({
        access_token_enc: encryptToken(tokens.access_token),
        refresh_token_enc: tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
        token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        scopes: tokens.scope?.split(' ') ?? null,
        client_state: webhookState,
        status: 'connected',
        last_ok_at: new Date().toISOString(),
        last_error: null,
      })
      .eq('id', connection.id)

    const subscription = await createSubscription(tokens.access_token, {
      mailbox: connection.mailbox_address,
      notificationUrl: `${clientEnv().NEXT_PUBLIC_APP_URL}/api/graph/webhook`,
      clientState: webhookState,
    })

    await db
      .from('mailbox_connections')
      .update({
        subscription_id: subscription.id,
        subscription_expires_at: subscription.expirationDateTime,
      })
      .eq('id', connection.id)

    await db.from('activity_log').insert({
      tenant_id: tenant.id,
      actor_id: user.id,
      actor_kind: 'user',
      entity_type: 'mailbox_connection',
      entity_id: connection.id,
      action: 'mailbox.connected',
      detail: { mailbox: connection.mailbox_address, subscription_id: subscription.id },
    })

    // Pick up anything already sitting in the inbox from today.
    await enqueue('renew_graph_subscription', { tenantId: tenant.id, dedupeKey: 'renew_graph_subscription' })

    settings.searchParams.set('connected', connection.mailbox_address)
    return NextResponse.redirect(settings)
  } catch (thrown) {
    const message =
      thrown instanceof GraphError ? thrown.message : thrown instanceof Error ? thrown.message : String(thrown)

    await db
      .from('mailbox_connections')
      .update({ status: 'error', last_error: message, last_error_at: new Date().toISOString() })
      .eq('id', connection.id)

    settings.searchParams.set('error', message)
    return NextResponse.redirect(settings)
  }
}
