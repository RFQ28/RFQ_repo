'use server'

import { revalidatePath } from 'next/cache'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { adminClient } from '@/lib/supabase/admin'
import type { UserRole } from '@/lib/db/types'

export type AdminActionState = { error?: string; message?: string }

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * Onboards a distributor: tenant row, seeded UOM table, and an invitation for
 * the first owner. Deliberately service-role only and behind a platform-admin
 * check -- there is no self-serve signup (PRD s12).
 */
export async function provisionTenant(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  await requirePlatformAdmin()

  const name = String(formData.get('name') ?? '').trim()
  const slug = String(formData.get('slug') ?? '').trim().toLowerCase()
  const ownerEmail = String(formData.get('owner_email') ?? '').trim().toLowerCase()
  const inbound = String(formData.get('inbound_address') ?? '').trim().toLowerCase()

  if (!name) return { error: 'Give the distributor a name.' }
  if (!SLUG_RE.test(slug)) {
    return { error: 'The slug must be 3-40 characters, lower case letters, numbers and hyphens.' }
  }
  if (ownerEmail && !EMAIL_RE.test(ownerEmail)) return { error: 'That owner email does not look right.' }

  const { data, error } = await adminClient().rpc('provision_tenant' as never, {
    p_slug: slug,
    p_name: name,
    p_owner_email: ownerEmail || null,
    p_inbound_address: inbound || null,
  } as never)

  if (error) {
    return error.message.includes('duplicate key')
      ? { error: `A distributor with the slug "${slug}" already exists.` }
      : { error: error.message }
  }

  revalidatePath('/admin')
  const tenant = data as unknown as { name: string } | null
  return { message: `${tenant?.name ?? name} is set up.${ownerEmail ? ` ${ownerEmail} can sign in now.` : ''}` }
}

const INVITABLE: UserRole[] = ['rep', 'owner', 'tenant_admin']

export async function inviteUser(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const session = await requirePlatformAdmin()

  const tenantId = String(formData.get('tenant_id') ?? '')
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const role = String(formData.get('role') ?? '') as UserRole

  if (!tenantId) return { error: 'Pick a distributor.' }
  if (!EMAIL_RE.test(email)) return { error: 'That email does not look right.' }
  if (!INVITABLE.includes(role)) return { error: 'Pick a role.' }

  const db = adminClient()

  // One open invitation per address at a time; a re-invite replaces the old one
  // rather than leaving two rows racing to be consumed at first sign-in.
  await db.from('invitations').delete().eq('email', email).is('accepted_at', null)

  const { error } = await db.from('invitations').insert({
    tenant_id: tenantId,
    email,
    role,
    invited_by: session.user.id,
  })

  if (error) return { error: error.message }

  revalidatePath('/admin')
  return { message: `${email} can now sign in as ${role.replace('_', ' ')}.` }
}
