import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-sm' : 'h-9 px-4 text-sm',
        variant === 'primary' && 'bg-accent text-white hover:bg-accent/90',
        variant === 'secondary' && 'border border-line-strong bg-surface text-ink hover:bg-canvas',
        variant === 'ghost' && 'text-ink-soft hover:bg-canvas hover:text-ink',
        variant === 'danger' && 'bg-flag text-white hover:bg-flag/90',
        className,
      )}
      {...props}
    />
  )
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink',
        'placeholder:text-ink-faint focus:border-accent focus:outline-none',
        className,
      )}
      {...props}
    />
  )
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-9 w-full rounded-md border border-line-strong bg-surface px-2 text-sm text-ink',
        'focus:border-accent focus:outline-none',
        className,
      )}
      {...props}
    />
  )
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('block text-sm font-medium text-ink-soft', className)} {...props} />
}

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('rounded-lg border border-line bg-surface', className)}
      {...props}
    />
  )
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-soft">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Callout({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'flag' | 'ok'
  title?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2.5 text-sm',
        tone === 'info' && 'border-line bg-accent-soft text-ink',
        tone === 'warn' && 'border-warn/25 bg-warn-soft text-warn',
        tone === 'flag' && 'border-flag/25 bg-flag-soft text-flag',
        tone === 'ok' && 'border-ok/25 bg-ok-soft text-ok',
      )}
    >
      {title && <p className="font-medium">{title}</p>}
      <div className={cn(title && 'mt-0.5')}>{children}</div>
    </div>
  )
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'flag' | 'accent'
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium',
        tone === 'neutral' && 'bg-canvas text-ink-soft',
        tone === 'ok' && 'bg-ok-soft text-ok',
        tone === 'warn' && 'bg-warn-soft text-warn',
        tone === 'flag' && 'bg-flag-soft text-flag',
        tone === 'accent' && 'bg-accent-soft text-accent',
      )}
    >
      {children}
    </span>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="mt-1 text-sm text-ink-soft">{children}</div>}
    </div>
  )
}
