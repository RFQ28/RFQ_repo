'use client'

import { createBrowserClient } from '@supabase/ssr'
import { clientEnv } from '@/lib/env'
import type { Database } from '@/lib/db/types'

/**
 * Browser client. Carries the user's JWT, so every query runs as
 * `authenticated` and is constrained by the policies in migration 0005.
 */
export function createClient() {
  const env = clientEnv()
  return createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  )
}
