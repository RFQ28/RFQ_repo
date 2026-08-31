import Link from 'next/link'
import { requireSession, hasRole } from '@/lib/auth/session'
import { SignOutButton } from '@/components/sign-out-button'
import { NavLink } from '@/components/nav-link'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, tenant } = await requireSession()
  const isAdmin = hasRole(user.role, 'owner')
  const name = user.full_name ?? user.email

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[1400px] items-center gap-6 px-6 py-3.5">
          <Link href="/rfqs" className="flex items-baseline gap-2.5">
            <span className="text-lg font-bold tracking-[-.01em] text-ink">Quote Desk</span>
            <span className="text-sm text-ink-faint">{tenant.name}</span>
          </Link>

          <nav className="ml-2 flex items-center gap-0.5">
            <NavLink href="/rfqs">RFQs</NavLink>
            <NavLink href="/quotes">Quotes</NavLink>
            {isAdmin && <NavLink href="/settings/catalogue">Catalogue</NavLink>}
            {isAdmin && <NavLink href="/settings/mailbox">Mailbox</NavLink>}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="font-medium text-ink-mid">{name}</span>
            <span
              aria-hidden
              className="grid size-[26px] place-items-center rounded-full bg-ink text-[11px] font-semibold text-white"
            >
              {initials(name)}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-6 py-8">{children}</main>
    </div>
  )
}

function initials(name: string): string {
  const parts = name.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean)
  return (parts[0]?.[0] ?? '?').concat(parts[1]?.[0] ?? '').toUpperCase()
}
