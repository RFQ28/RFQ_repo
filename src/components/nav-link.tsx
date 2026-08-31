'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname()
  const active = pathname === href || pathname.startsWith(`${href}/`)

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'rounded-[7px] px-3 py-2 text-base transition-colors',
        active
          ? 'bg-accent-soft font-semibold text-accent-ink'
          : 'font-medium text-ink-mid hover:bg-fill hover:text-ink',
      )}
    >
      {children}
    </Link>
  )
}
