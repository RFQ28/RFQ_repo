import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth/session'
import { SignOutButton } from '@/components/sign-out-button'

/**
 * Where someone lands if they authenticated but no invitation matched their
 * address. Onboarding is by hand (PRD s12), so this is a normal state, not an
 * error -- it just means an admin has not attached them yet.
 */
export default async function PendingPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.user.role === 'platform_admin') redirect('/admin')
  if (session.tenant) redirect('/rfqs')

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Almost there</h1>
        <p className="mt-2 text-sm text-ink-soft">
          You are signed in as <span className="font-medium text-ink">{session.user.email}</span>, but
          that address is not attached to a distributor yet. Ask your administrator to invite it, then
          sign in again.
        </p>
        <div className="mt-6">
          <SignOutButton />
        </div>
      </div>
    </main>
  )
}
