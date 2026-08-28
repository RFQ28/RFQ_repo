'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { clientEnv } from '@/lib/env'
import { Button, Input, Label } from '@/components/ui'

export function LoginForm({ next }: { next: string }) {
  const router = useRouter()
  const [showPassword, setShowPassword] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function signInWithMicrosoft() {
    setBusy(true)
    setError(null)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: {
        // Mail scopes are requested separately, by an owner, when the mailbox
        // is connected -- signing in must not ask a rep for mailbox access.
        scopes: 'email openid profile',
        redirectTo: `${clientEnv().NEXT_PUBLIC_APP_URL}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    })
    if (error) {
      setError(error.message)
      setBusy(false)
    }
  }

  async function signInWithPassword(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setBusy(false)
      return
    }
    router.push(next)
    router.refresh()
  }

  return (
    <div className="space-y-4">
      <Button className="w-full" onClick={signInWithMicrosoft} disabled={busy}>
        Continue with Microsoft
      </Button>

      {error && <p className="text-sm text-flag">{error}</p>}

      {!showPassword ? (
        <button
          type="button"
          className="w-full text-center text-sm text-ink-faint hover:text-ink-soft"
          onClick={() => setShowPassword(true)}
        >
          Sign in with a password instead
        </button>
      ) : (
        <form onSubmit={signInWithPassword} className="space-y-3 border-t border-line pt-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button type="submit" variant="secondary" className="w-full" disabled={busy}>
            Sign in
          </Button>
        </form>
      )}
    </div>
  )
}
