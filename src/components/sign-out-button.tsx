'use client'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export function SignOutButton() {
  const router = useRouter()

  return (
    <button
      type="button"
      className="text-ink-faint transition-colors hover:text-ink"
      onClick={async () => {
        await createClient().auth.signOut()
        router.push('/login')
        router.refresh()
      }}
    >
      Sign out
    </button>
  )
}
