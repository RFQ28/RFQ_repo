'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Callout, Card, Input, Label, Select } from '@/components/ui'
import { inviteUser, provisionTenant, type AdminActionState } from './actions'

function Submit({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? busy : idle}
    </Button>
  )
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export function ProvisionForm() {
  const [state, action] = useActionState<AdminActionState, FormData>(provisionTenant, {})
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)

  return (
    <Card className="p-4">
      <h2 className="text-sm font-medium text-ink">Onboard a distributor</h2>
      <p className="mt-0.5 mb-3 text-sm text-ink-soft">
        Creates the tenant, seeds its unit-conversion table, and invites the first owner.
      </p>

      <form action={action} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            name="name"
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              if (!slugTouched) setSlug(slugify(e.target.value))
            }}
            placeholder="Midwest Electric Supply"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="slug">Slug</Label>
          <Input
            id="slug"
            name="slug"
            required
            value={slug}
            onChange={(e) => {
              setSlugTouched(true)
              setSlug(slugify(e.target.value))
            }}
            placeholder="midwest-electric"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="owner_email">Owner email</Label>
          <Input id="owner_email" name="owner_email" type="email" placeholder="owner@distributor.com" />
          <p className="text-xs text-ink-faint">
            They sign in with Microsoft; the invitation is consumed on first sign-in.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="inbound_address">Inbound forwarding address</Label>
          <Input id="inbound_address" name="inbound_address" placeholder="tenant-abc@inbound.vmsa.app" />
          <p className="text-xs text-ink-faint">
            Optional. Only needed when the owner will not grant Graph mailbox access.
          </p>
        </div>

        {state.error && <Callout tone="flag">{state.error}</Callout>}
        {state.message && <Callout tone="ok">{state.message}</Callout>}

        <Submit idle="Provision" busy="Provisioning…" />
      </form>
    </Card>
  )
}

export function InviteForm({ tenants }: { tenants: { id: string; name: string }[] }) {
  const [state, action] = useActionState<AdminActionState, FormData>(inviteUser, {})

  return (
    <Card className="p-4">
      <h2 className="text-sm font-medium text-ink">Invite a user</h2>
      <p className="mt-0.5 mb-3 text-sm text-ink-soft">
        The address is attached to the tenant the first time they sign in.
      </p>

      <form action={action} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="tenant_id">Distributor</Label>
          <Select id="tenant_id" name="tenant_id" required disabled={tenants.length === 0}>
            {tenants.length === 0 && <option value="">No distributors yet</option>}
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" required placeholder="rep@distributor.com" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="role">Role</Label>
          <Select id="role" name="role" defaultValue="rep">
            <option value="rep">Rep — reviews and sends quotes</option>
            <option value="owner">Owner — plus catalogue, pricing and users</option>
            <option value="tenant_admin">Tenant admin — same as owner</option>
          </Select>
        </div>

        {state.error && <Callout tone="flag">{state.error}</Callout>}
        {state.message && <Callout tone="ok">{state.message}</Callout>}

        <Submit idle="Send invitation" busy="Inviting…" />
      </form>
    </Card>
  )
}
