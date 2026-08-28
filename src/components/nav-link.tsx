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
      className={cn(
        'rounded-md px-2.5 py-1.5 text-sm transition-colors',
        active ? 'bg-accent-soft font-medium text-accent' : 'text-ink-soft hover:bg-canvas hover:text-ink',
      )}
    >
      {children}
    </Link>
  )
}
