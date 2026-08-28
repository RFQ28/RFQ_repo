import 'server-only'

import { redirect } from 'next/navigation'
import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import type { TenantRow, UserRow, UserRole } from '@/lib/db/types'

export type Session = {
  user: UserRow
  tenant: TenantRow | null
}

/**
 * The signed-in user's profile and tenant, or null.
 *
 * `cache` dedupes this across a single render pass, so a layout and the page
 * inside it share one round trip.
 */
export const getSession = cache(async (): Promise<Session | null> => {
  const supabase = await createClient()

  // getUser(), not getSession(): the latter trusts the cookie without asking
  // the auth server whether the JWT is still good.
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return null

  const { data: profile } = await supabase
    .from('users')
    .select('*')
    .eq('id', auth.user.id)
    .maybeSingle()

  if (!profile) return null

  let tenant: TenantRow | null = null
  if (profile.tenant_id) {
    const { data } = await supabase
      .from('tenants')
      .select('*')
      .eq('id', profile.tenant_id)
      .maybeSingle()
    tenant = data ?? null
  }

  return { user: profile, tenant }
})

/** Signed in, attached to a tenant, and active. Anything else is redirected. */
export async function requireSession(): Promise<Session & { tenant: TenantRow }> {
  const session = await getSession()
  if (!session) redirect('/login')
  if (!session.user.is_active) redirect('/login?error=deactivated')
  // A platform admin belongs to no tenant by construction; their work lives
  // under /admin, where a tenant is chosen explicitly.
  if (session.user.role === 'platform_admin') redirect('/admin')
  if (session.user.role === 'pending' || !session.tenant) redirect('/pending')
  return session as Session & { tenant: TenantRow }
}

const RANK: Record<UserRole, number> = {
  pending: 0,
  rep: 1,
  owner: 2,
  tenant_admin: 2,
  platform_admin: 3,
}

export function hasRole(role: UserRole, atLeast: UserRole): boolean {
  return RANK[role] >= RANK[atLeast]
}

/** Tenant-admin work: catalogue ingestion, pricing, mailbox setup, users. */
export async function requireTenantAdmin() {
  const session = await requireSession()
  if (!hasRole(session.user.role, 'owner')) redirect('/rfqs?error=forbidden')
  return session
}

/** VMSA-internal screens. */
export async function requirePlatformAdmin() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.user.role !== 'platform_admin') redirect('/rfqs?error=forbidden')
  return session
}
