import 'server-only'

import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js'
import { clientEnv, serverEnv } from '@/lib/env'
import type { Database } from '@/lib/db/types'

export type AdminClient = SupabaseClient<Database>

let cached: AdminClient | null = null

/**
 * Service-role client. Postgres grants this role BYPASSRLS, so **nothing in
 * migration 0005 constrains it**. Reach for it only where a user session cannot
 * do the work: webhooks, queue workers, tenant provisioning.
 *
 * For anything scoped to one distributor, use `tenantDb()` in ./tenant.ts
 * instead -- it stamps and filters tenant_id on every call, which is what keeps
 * background jobs from crossing a tenant boundary.
 */
export function adminClient(): AdminClient {
  if (cached) return cached
  const { NEXT_PUBLIC_SUPABASE_URL } = clientEnv()
  const { SUPABASE_SERVICE_ROLE_KEY } = serverEnv()

  cached = createSupabaseClient<Database>(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}
