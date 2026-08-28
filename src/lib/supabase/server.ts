import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { clientEnv } from '@/lib/env'
import type { Database } from '@/lib/db/types'

/**
 * Server client for Server Components, Route Handlers and Server Actions.
 * Still runs as `authenticated` -- RLS applies. Use this for anything a user
 * asked for; reach for the service-role client only for background work.
 */
export async function createClient() {
  const cookieStore = await cookies()
  const env = clientEnv()

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // The middleware refresh path handles rotation instead.
          }
        },
      },
    },
  )
}
