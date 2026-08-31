import { requirePlatformAdmin } from '@/lib/auth/session'
import { adminClient } from '@/lib/supabase/admin'
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui'
import { SignOutButton } from '@/components/sign-out-button'
import { ProvisionForm, InviteForm } from './forms'

export default async function AdminPage() {
  const session = await requirePlatformAdmin()
  const db = adminClient()

  // Platform admins are the one role that sees across tenants, by design.
  const [{ data: tenants }, { data: invitations }] = await Promise.all([
    db
      .from('tenants')
      .select('id, name, slug, status, created_at, users(id), products(id)')
      .order('created_at', { ascending: false }),
    db
      .from('invitations')
      .select('id, email, role, expires_at, tenants(name)')
      .is('accepted_at', null)
      .order('created_at', { ascending: false })
      .limit(25),
  ])

  const tenantOptions = (tenants ?? []).map((t) => ({ id: t.id, name: t.name }))

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-[1200px] items-center px-5">
          <span className="text-sm font-semibold text-ink">
            Quote Desk <span className="ml-2 font-normal text-ink-faint">platform admin</span>
          </span>
          <div className="ml-auto flex items-center gap-3 text-sm text-ink-faint">
            {session.user.email}
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1200px] px-5 py-8">
        <PageHeader
          title="Distributors"
          description="Every tenant is onboarded by hand — catalogue and pricing ingestion needs a human eye."
        />

        <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
          <div className="space-y-6">
            <ProvisionForm />
            <InviteForm tenants={tenantOptions} />
          </div>

          <div className="space-y-6">
            {!tenants || tenants.length === 0 ? (
              <EmptyState title="No distributors yet">
                <p>Provision the design partner to get started.</p>
              </EmptyState>
            ) : (
              <Card className="overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="border-b border-line bg-sunken text-left text-micro font-medium tracking-[.13em] text-ink-dim uppercase">
                    <tr>
                      <th className="px-4 py-2.5">Distributor</th>
                      <th className="px-4 py-2.5">Users</th>
                      <th className="px-4 py-2.5">Products</th>
                      <th className="px-4 py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenants.map((tenant) => (
                      <tr key={tenant.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-2.5">
                          <p className="font-medium text-ink">{tenant.name}</p>
                          <p className="font-mono text-xs text-ink-faint">{tenant.slug}</p>
                        </td>
                        <td className="nums px-4 py-2.5 text-ink-soft">
                          {(tenant.users as unknown[]).length}
                        </td>
                        <td className="nums px-4 py-2.5 text-ink-soft">
                          {(tenant.products as unknown[]).length}
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge tone={tenant.status === 'active' ? 'ok' : 'neutral'}>
                            {tenant.status}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}

            {invitations && invitations.length > 0 && (
              <div>
                <h2 className="mb-2 text-sm font-medium text-ink-soft">Open invitations</h2>
                <Card className="divide-y divide-line">
                  {invitations.map((invite) => (
                    <div key={invite.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                      <span className="font-medium text-ink">{invite.email}</span>
                      <Badge>{invite.role.replace('_', ' ')}</Badge>
                      <span className="text-ink-faint">
                        {(invite.tenants as { name: string } | null)?.name ?? 'platform'}
                      </span>
                      <span className="ml-auto text-xs text-ink-faint">
                        expires {new Date(invite.expires_at).toLocaleDateString('en-US')}
                      </span>
                    </div>
                  ))}
                </Card>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
