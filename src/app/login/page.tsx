import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth/session'
import { LoginForm } from './login-form'

const ERRORS: Record<string, string> = {
  deactivated: 'That account has been deactivated. Ask your administrator to re-enable it.',
  callback: 'Sign-in did not complete. Try again.',
  forbidden: 'You do not have access to that page.',
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await getSession()
  if (session) redirect('/rfqs')

  const params = await searchParams
  const errorKey = typeof params.error === 'string' ? params.error : null
  const next = typeof params.next === 'string' ? params.next : '/rfqs'

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <p className="text-sm font-medium tracking-wide text-accent uppercase">Quote Desk</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">Sign in</h1>
          <p className="mt-2 text-sm text-ink-soft">
            Use the Microsoft account you already sign in to Outlook with.
          </p>
        </div>

        {errorKey && (
          <div className="mb-4 rounded-md border border-flag/25 bg-flag-soft px-3 py-2.5 text-sm text-flag">
            {ERRORS[errorKey] ?? 'Something went wrong. Try again.'}
          </div>
        )}

        <LoginForm next={next} />
      </div>
    </main>
  )
}
