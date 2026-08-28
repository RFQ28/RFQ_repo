import { requireTenantAdmin } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { graphConfigured } from '@/lib/graph/client'
import { encryptionAvailable } from '@/lib/crypto/tokens'
import { Badge, Callout, Card, PageHeader } from '@/components/ui'
import { MailboxForms } from './mailbox-forms'

export default async function MailboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { tenant } = await requireTenantAdmin()
  const params = await searchParams
  const supabase = await createClient()

  const { data: connections } = await supabase
    .from('mailbox_connections')
    .select('id, method, mailbox_address, inbound_address, status, subscription_expires_at, last_ok_at, last_error, last_error_at')
    .eq('tenant_id', tenant.id)

  const graph = connections?.find((c) => c.method === 'graph') ?? null
  const forwarding = connections?.find((c) => c.method === 'forwarding') ?? null

  // Recent intake, so an owner can see the machine is running (PRD s3).
  const { data: recent } = await adminClient()
    .from('inbound_emails')
    .select('id, from_address, subject, received_at')
    .eq('tenant_id', tenant.id)
    .order('received_at', { ascending: false })
    .limit(10)

  const configured = graphConfigured()
  const encryption = encryptionAvailable()

  const error = typeof params.error === 'string' ? params.error : null
  const connected = typeof params.connected === 'string' ? params.connected : null

  return (
    <>
      <PageHeader
        title="Quotes mailbox"
        description="RFQs are read straight from the shared inbox. Nobody forwards anything by hand, ever."
      />

      <div className="mb-6 space-y-3">
        {connected && (
          <Callout tone="ok" title="Connected">
            {connected} is being watched. New RFQs will appear within a few minutes of arriving.
          </Callout>
        )}
        {error && (
          <Callout tone="flag" title="That did not work">
            {error}
          </Callout>
        )}
        {!configured && (
          <Callout tone="warn" title="Microsoft Graph is not configured on this deployment">
            Set <code className="font-mono">MS_CLIENT_ID</code>, <code className="font-mono">MS_CLIENT_SECRET</code>{' '}
            and <code className="font-mono">MS_REDIRECT_URI</code> from an Entra app registration. Until then only
            the forwarding fallback is available.
          </Callout>
        )}
        {!encryption && (
          <Callout tone="flag" title="Token encryption is not configured">
            <code className="font-mono">TOKEN_ENCRYPTION_KEY</code> is unset, and mailbox tokens are never stored
            without it. Generate one with{' '}
            <code className="font-mono">
              node -e &quot;console.log(require(&apos;crypto&apos;).randomBytes(32).toString(&apos;base64&apos;))&quot;
            </code>
            .
          </Callout>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[440px_1fr]">
        <div className="space-y-6">
          {graph && graph.status !== 'disconnected' ? (
            <Card className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <h2 className="text-sm font-medium text-ink">{graph.mailbox_address}</h2>
                <Badge tone={graph.status === 'connected' ? 'ok' : graph.status === 'degraded' ? 'warn' : 'flag'}>
                  {graph.status}
                </Badge>
              </div>

              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-faint">Watching since</dt>
                  <dd className="nums text-ink-soft">
                    {graph.last_ok_at ? new Date(graph.last_ok_at).toLocaleString('en-US') : '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-faint">Subscription renews before</dt>
                  <dd className="nums text-ink-soft">
                    {graph.subscription_expires_at
                      ? new Date(graph.subscription_expires_at).toLocaleString('en-US')
                      : '—'}
                  </dd>
                </div>
              </dl>

              {graph.last_error && (
                <div className="mt-3">
                  <Callout tone="flag" title="Last error">
                    {graph.last_error}
                  </Callout>
                </div>
              )}

              <p className="mt-3 text-xs text-ink-faint">
                Read access only. Nothing is ever sent from this mailbox without a rep pressing send.
              </p>
            </Card>
          ) : null}

          <MailboxForms
            configured={configured}
            encryptionReady={encryption}
            connected={Boolean(graph && graph.status !== 'disconnected')}
            currentMailbox={graph?.mailbox_address ?? ''}
            forwardingAddress={forwarding?.inbound_address ?? null}
            forwardingFrom={forwarding?.mailbox_address ?? ''}
          />
        </div>

        <div>
          <h2 className="mb-2 text-sm font-medium text-ink-soft">Recently received</h2>
          {!recent || recent.length === 0 ? (
            <Card className="px-4 py-8 text-center text-sm text-ink-faint">
              Nothing has arrived yet.
            </Card>
          ) : (
            <Card className="divide-y divide-line">
              {recent.map((email) => (
                <div key={email.id} className="px-4 py-2.5 text-sm">
                  <p className="font-medium text-ink">{email.subject ?? '(no subject)'}</p>
                  <p className="text-ink-faint">
                    {email.from_address}
                    <span className="nums ml-2">
                      {new Date(email.received_at).toLocaleString('en-US', {
                        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                      })}
                    </span>
                  </p>
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>
    </>
  )
}
