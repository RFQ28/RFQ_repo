import 'server-only'

import { decryptToken, encryptToken } from '@/lib/crypto/tokens'
import { adminClient } from '@/lib/supabase/admin'
import type { MailboxConnectionRow } from '@/lib/db/types'

/**
 * Microsoft Graph (PRD 6.1).
 *
 * The owner authorises once; after that the system watches the shared quotes
 * mailbox and receives a webhook on new mail. Two things this file is careful
 * about:
 *
 *   - **Read only.** The scopes requested never include Mail.Send. Sending the
 *     finished quote back into the thread is a separate, explicit action
 *     (s9: "never send from their mailbox without explicit action").
 *   - **Subscriptions expire.** Graph caps a mail subscription at under three
 *     days. Renewal is a scheduled job, and a failure to renew alerts rather
 *     than quietly stopping the flow of RFQs.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0'
const LOGIN = 'https://login.microsoftonline.com'

/**
 * Read mail and identify the signer. Deliberately no write or send scope.
 *
 * `Mail.Read.Shared` is the one that matters and is easy to get wrong:
 * `Mail.Read` grants only the signed-in user's *own* mailbox, and the whole
 * premise here is watching a shared one (quotes@distributor.com) that the owner
 * has Full Access to. Without the .Shared scope every real deployment gets a
 * 403 from `/users/{mailbox}/messages`. `Mail.Read` stays for the case where a
 * distributor points us at the owner's own inbox instead.
 */
export const SCOPES = [
  'offline_access', 'openid', 'email', 'profile',
  'Mail.Read', 'Mail.Read.Shared', 'User.Read',
]

/**
 * Graph refuses an expiry beyond 4230 minutes for a message subscription, so
 * renewal is scheduled well inside that rather than at the limit.
 */
export const SUBSCRIPTION_MINUTES = 4_000
export const RENEW_WHEN_WITHIN_MINUTES = 720

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message)
  }
}

function config() {
  const clientId = process.env.MS_CLIENT_ID
  const clientSecret = process.env.MS_CLIENT_SECRET
  const redirectUri = process.env.MS_REDIRECT_URI
  if (!clientId || !clientSecret || !redirectUri) {
    throw new GraphError('Microsoft Graph is not configured — see MS_* in .env.example', 500)
  }
  return { clientId, clientSecret, redirectUri }
}

export function graphConfigured(): boolean {
  return Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && process.env.MS_REDIRECT_URI)
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/** Where to send an owner to authorise access to their shared mailbox. */
export function authorizeUrl(state: string, msTenant = 'common'): string {
  const { clientId, redirectUri } = config()
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state,
    // Force the consent screen so an owner sees exactly which permissions they
    // are granting, rather than silently inheriting an earlier grant.
    prompt: 'consent',
  })
  return `${LOGIN}/${msTenant}/oauth2/v2.0/authorize?${params}`
}

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
}

async function requestToken(body: URLSearchParams, msTenant: string): Promise<TokenResponse> {
  const response = await fetch(`${LOGIN}/${msTenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new GraphError(
      `Microsoft rejected the token request: ${(payload as { error_description?: string }).error_description ?? response.statusText}`,
      response.status,
      payload,
    )
  }
  return payload as TokenResponse
}

export async function exchangeCode(code: string, msTenant = 'common'): Promise<TokenResponse> {
  const { clientId, clientSecret, redirectUri } = config()
  return requestToken(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    msTenant,
  )
}

export async function refreshAccessToken(refreshToken: string, msTenant = 'common'): Promise<TokenResponse> {
  const { clientId, clientSecret } = config()
  return requestToken(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: SCOPES.join(' '),
    }),
    msTenant,
  )
}

/**
 * A valid access token for a connection, refreshing and re-storing when needed.
 *
 * Refreshed a minute early: a token that expires between this check and the
 * request that uses it produces a 401 that looks like a permissions problem.
 */
export async function accessTokenFor(connection: MailboxConnectionRow): Promise<string> {
  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0

  if (connection.access_token_enc && expiresAt > Date.now() + 60_000) {
    return decryptToken(connection.access_token_enc)
  }

  if (!connection.refresh_token_enc) {
    throw new GraphError('This mailbox has no refresh token — it needs reconnecting', 401)
  }

  const refreshed = await refreshAccessToken(
    decryptToken(connection.refresh_token_enc),
    connection.ms_tenant_id ?? 'common',
  )

  const patch: Partial<MailboxConnectionRow> = {
    access_token_enc: encryptToken(refreshed.access_token),
    token_expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
    status: 'connected',
    last_ok_at: new Date().toISOString(),
    last_error: null,
  }
  // Microsoft rotates refresh tokens; dropping the new one would work until the
  // old one expired and then fail in a way nobody could explain.
  if (refreshed.refresh_token) patch.refresh_token_enc = encryptToken(refreshed.refresh_token)

  await adminClient().from('mailbox_connections').update(patch).eq('id', connection.id)

  return refreshed.access_token
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function graphFetch(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new GraphError(
      `Graph ${init.method ?? 'GET'} ${path} failed: ${response.status}${explain(body)}`,
      response.status,
      body,
    )
  }

  return response
}

/**
 * Graph's own account of what went wrong, appended to the thrown message.
 *
 * The status alone is close to useless to whoever is doing the onboarding. A
 * 404 from POST /subscriptions reads as "the endpoint is wrong" when what
 * Graph actually said was `The requested user 'x@outlook.com' is invalid` —
 * i.e. the address typed into the form is not a mailbox in this tenant. That
 * sentence is the whole diagnosis, it was already being fetched, and it was
 * being dropped on the floor before it reached the screen.
 */
function explain(body: string): string {
  if (!body) return ''
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; message?: string; innerError?: { message?: string } }
    }
    const code = parsed.error?.code
    const message = parsed.error?.message ?? parsed.error?.innerError?.message
    if (!code && !message) return ''
    // Graph nests the useful sentence inside a wrapper for subscription
    // failures: "Operation: Create; Exception: [Status Code: NotFound;
    // Reason: The requested user 'x' is invalid.]"
    const reason = message?.match(/Reason:\s*([^\]]+)/)?.[1]?.trim()
    return ` — ${[code, reason ?? message].filter(Boolean).join(': ')}`
  } catch {
    return ` — ${body.slice(0, 200)}`
  }
}

export type GraphMessage = {
  id: string
  internetMessageId: string
  conversationId: string | null
  subject: string | null
  receivedDateTime: string
  hasAttachments: boolean
  from?: { emailAddress?: { address?: string; name?: string } }
  toRecipients?: { emailAddress?: { address?: string } }[]
  ccRecipients?: { emailAddress?: { address?: string } }[]
  body?: { contentType?: string; content?: string }
  bodyPreview?: string
  internetMessageHeaders?: { name: string; value: string }[]
}

/** One message, with the headers the classifier uses to spot bulk mail. */
export async function getMessage(
  token: string,
  mailbox: string,
  messageId: string,
): Promise<GraphMessage> {
  const select = [
    'id', 'internetMessageId', 'conversationId', 'subject', 'receivedDateTime',
    'hasAttachments', 'from', 'toRecipients', 'ccRecipients', 'body', 'bodyPreview',
    'internetMessageHeaders',
  ].join(',')

  const response = await graphFetch(
    token,
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}?$select=${select}`,
  )
  return response.json()
}

export type GraphAttachment = {
  id: string
  name: string
  contentType: string
  size: number
  isInline: boolean
  contentBytes?: string
}

export async function getAttachments(
  token: string,
  mailbox: string,
  messageId: string,
): Promise<GraphAttachment[]> {
  const response = await graphFetch(
    token,
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments`,
  )
  const payload = (await response.json()) as { value?: GraphAttachment[] }

  // Only file attachments carry contentBytes; item attachments (a forwarded
  // message, a calendar item) come back without one and are skipped rather
  // than stored as empty files.
  return (payload.value ?? []).filter((attachment) => typeof attachment.contentBytes === 'string')
}

/** The original message, byte for byte, for permanent storage (6.1). */
export async function getMimeContent(
  token: string,
  mailbox: string,
  messageId: string,
): Promise<ArrayBuffer> {
  const response = await graphFetch(
    token,
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/$value`,
  )
  return response.arrayBuffer()
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export type GraphSubscription = {
  id: string
  resource: string
  expirationDateTime: string
  clientState?: string
}

export function subscriptionExpiry(minutes = SUBSCRIPTION_MINUTES): string {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

export async function createSubscription(
  token: string,
  options: { mailbox: string; notificationUrl: string; clientState: string },
): Promise<GraphSubscription> {
  const response = await graphFetch(token, '/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      changeType: 'created',
      notificationUrl: options.notificationUrl,
      resource: `/users/${options.mailbox}/mailFolders('inbox')/messages`,
      expirationDateTime: subscriptionExpiry(),
      clientState: options.clientState,
    }),
  })
  return response.json()
}

export async function renewSubscription(
  token: string,
  subscriptionId: string,
): Promise<GraphSubscription> {
  const response = await graphFetch(token, `/subscriptions/${subscriptionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ expirationDateTime: subscriptionExpiry() }),
  })
  return response.json()
}

export async function deleteSubscription(token: string, subscriptionId: string): Promise<void> {
  await graphFetch(token, `/subscriptions/${subscriptionId}`, { method: 'DELETE' }).catch(() => {
    // A subscription that is already gone is the state we wanted.
  })
}

/**
 * Messages that arrived while we were not listening.
 *
 * A webhook can be missed — a deploy, an outage, an expired subscription — and
 * 6.1 says no RFQ may be lost to that. This is the catch-up sweep the renewal
 * job runs alongside renewal.
 */
export async function listRecentMessages(
  token: string,
  mailbox: string,
  since: Date,
  limit = 50,
): Promise<GraphMessage[]> {
  const filter = encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)
  const select = ['id', 'internetMessageId', 'conversationId', 'subject', 'receivedDateTime', 'hasAttachments', 'from'].join(',')

  const response = await graphFetch(
    token,
    `/users/${encodeURIComponent(mailbox)}/mailFolders('inbox')/messages` +
      `?$filter=${filter}&$select=${select}&$top=${limit}&$orderby=receivedDateTime desc`,
  )
  const payload = (await response.json()) as { value?: GraphMessage[] }
  return payload.value ?? []
}

export function headersToRecord(message: GraphMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const header of message.internetMessageHeaders ?? []) {
    out[header.name.toLowerCase()] = header.value
  }
  return out
}
