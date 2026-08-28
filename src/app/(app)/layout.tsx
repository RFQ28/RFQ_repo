import Link from 'next/link'
import { requireSession } from '@/lib/auth/session'
import { SignOutButton } from '@/components/sign-out-button'
import { NavLink } from '@/components/nav-link'
import { hasRole } from '@/lib/auth/session'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, tenant } = await requireSession()
  const isAdmin = hasRole(user.role, 'owner')

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-6 px-5">
          <Link href="/rfqs" className="text-sm font-semibold tracking-tight text-ink">
            Quote Desk
            <span className="ml-2 font-normal text-ink-faint">{tenant.name}</span>
          </Link>

          <nav className="flex items-center gap-1">
            <NavLink href="/rfqs">RFQs</NavLink>
            <NavLink href="/quotes">Quotes</NavLink>
            {isAdmin && <NavLink href="/settings/catalogue">Catalogue</NavLink>}
            {isAdmin && <NavLink href="/settings/mailbox">Mailbox</NavLink>}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-ink-faint">{user.full_name ?? user.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-5 py-8">{children}</main>
    </div>
  )
}
