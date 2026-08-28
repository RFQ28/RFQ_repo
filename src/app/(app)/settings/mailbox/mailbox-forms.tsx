'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Callout, Card, Input, Label } from '@/components/ui'
import { connectMailbox, disconnectMailbox, useForwardingAddress, type MailboxActionState } from './actions'

function Submit({ idle, busy, variant = 'primary' }: { idle: string; busy: string; variant?: 'primary' | 'secondary' }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant={variant} disabled={pending} className="w-full">
      {pending ? busy : idle}
    </Button>
  )
}

export function MailboxForms({
  configured,
  encryptionReady,
  connected,
  currentMailbox,
  forwardingAddress,
  forwardingFrom,
}: {
  configured: boolean
  encryptionReady: boolean
  connected: boolean
  currentMailbox: string
  forwardingAddress: string | null
  forwardingFrom: string
}) {
  const [connectState, connect] = useActionState<MailboxActionState, FormData>(connectMailbox, {})
  const [forwardState, forward] = useActionState<MailboxActionState, FormData>(useForwardingAddress, {})
  const [disconnectState, setDisconnectState] = useState<MailboxActionState>({})
  const [showFallback, setShowFallback] = useState(Boolean(forwardingAddress))

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <h2 className="text-sm font-medium text-ink">
          {connected ? 'Reconnect the mailbox' : 'Connect the mailbox'}
        </h2>
        <p className="mt-0.5 mb-3 text-sm text-ink-soft">
          The owner signs in once with Microsoft. We ask for permission to read mail and nothing else.
        </p>

        <form action={connect} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="mailbox">Shared mailbox</Label>
            <Input
              id="mailbox"
              name="mailbox"
              type="email"
              required
              defaultValue={currentMailbox}
              placeholder="quotes@distributor.com"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ms_tenant">Microsoft tenant</Label>
            <Input id="ms_tenant" name="ms_tenant" defaultValue="common" placeholder="common" />
            <p className="text-xs text-ink-faint">
              Leave as <code className="font-mono">common</code> unless their IT gave you a tenant id.
            </p>
          </div>

          {connectState.error && <Callout tone="flag">{connectState.error}</Callout>}

          <Submit
            idle={connected ? 'Reconnect with Microsoft' : 'Continue with Microsoft'}
            busy="Redirecting…"
          />
          {!configured && (
            <p className="text-xs text-warn">
              This deployment has no Microsoft app configured, so this will not work yet.
            </p>
          )}
          {!encryptionReady && (
            <p className="text-xs text-flag">Set TOKEN_ENCRYPTION_KEY before connecting.</p>
          )}
        </form>

        {connected && (
          <form
            className="mt-3"
            action={async () => {
              setDisconnectState(await disconnectMailbox())
            }}
          >
            <Button type="submit" variant="ghost" size="sm">
              Disconnect
            </Button>
          </form>
        )}

        {disconnectState.error && <Callout tone="flag">{disconnectState.error}</Callout>}
        {disconnectState.message && <Callout tone="ok">{disconnectState.message}</Callout>}
      </Card>

      {!showFallback ? (
        <button
          type="button"
          className="text-sm text-ink-faint hover:text-ink-soft"
          onClick={() => setShowFallback(true)}
        >
          Their IT will not grant mailbox access
        </button>
      ) : (
        <Card className="p-4">
          <h2 className="text-sm font-medium text-ink">Forwarding instead</h2>
          <p className="mt-0.5 mb-3 text-sm text-ink-soft">
            Their IT sets one server-side rule copying the quotes inbox to an address we own. No rep ever
            forwards anything by hand — the rule does it.
          </p>

          <form action={forward} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="forward-mailbox">Mailbox their rule copies from</Label>
              <Input
                id="forward-mailbox"
                name="mailbox"
                type="email"
                required
                defaultValue={forwardingFrom}
                placeholder="quotes@distributor.com"
              />
            </div>

            {forwardingAddress && (
              <div className="rounded-md bg-canvas px-3 py-2">
                <p className="text-xs text-ink-faint">Forward to</p>
                <p className="font-mono text-sm text-ink">{forwardingAddress}</p>
              </div>
            )}

            {forwardState.error && <Callout tone="flag">{forwardState.error}</Callout>}
            {forwardState.message && <Callout tone="ok">{forwardState.message}</Callout>}

            <Submit idle="Set up forwarding" busy="Saving…" variant="secondary" />
          </form>

          <p className="mt-3 text-xs text-ink-faint">
            Receiving mail at that address needs an inbound provider wired to{' '}
            <code className="font-mono">/api/inbound</code>, which is not built yet.
          </p>
        </Card>
      )}
    </div>
  )
}
