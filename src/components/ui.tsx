import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * One primary action per view, and it is ink — there is no accent hue to spend.
 * `secondary` inverts to ink on hover so the row's commit action still feels
 * like the heaviest thing on the row without shouting from across the screen.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
}) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[7px] transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'px-3 py-2 text-sm' : 'px-5 py-2.5 text-base',
        variant === 'primary' &&
          'bg-ink font-semibold text-white shadow-primary hover:bg-[#2a2d35]',
        variant === 'secondary' &&
          'border border-line-strong bg-surface font-semibold text-ink shadow-control hover:border-ink hover:bg-ink hover:text-white',
        variant === 'ghost' && 'font-medium text-ink-mid hover:bg-fill-strong hover:text-ink',
        variant === 'danger' && 'font-medium text-block hover:bg-block-tint',
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
        'w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5 text-base text-ink',
        'placeholder:text-ink-dim focus:border-ink focus:shadow-[0_0_0_3px_rgba(20,22,28,.08)] focus:outline-none',
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
        'w-full rounded-lg border border-line-strong bg-surface px-2 py-2.5 text-base text-ink',
        'focus:border-ink focus:outline-none',
        className,
      )}
      {...props}
    />
  )
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('block text-sm font-medium text-ink-mid', className)} {...props} />
}

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('overflow-hidden rounded-xl border border-line bg-surface shadow-card', className)}
      {...props}
    />
  )
}

/** Uppercase, tracked, and small enough to disappear until you look for it. */
export function Eyebrow({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('text-2xs font-semibold tracking-[.09em] text-ink-dim uppercase', className)}
      {...props}
    />
  )
}

/** A quote number, an import id — an identifier you might read aloud. */
export function MonoTag({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-[5px] bg-fill-strong px-[7px] py-[5px] font-mono text-2xs font-medium whitespace-nowrap text-ink-mid',
        className,
      )}
    >
      {children}
    </span>
  )
}

export function KeyCap({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-sm border border-control border-b-2 bg-surface px-[5px] py-1 font-mono text-[10px] font-medium text-ink">
      {children}
    </kbd>
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
        <h1 className="text-2xl font-semibold tracking-[-.02em] text-ink">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-ink-faint">{description}</p>}
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
        'rounded-[10px] border px-4 py-3 text-sm',
        tone === 'info' && 'border-line bg-sunken text-ink-soft',
        tone === 'warn' && 'border-review-edge bg-warn-soft text-review',
        tone === 'flag' && 'border-block-edge bg-flag-soft text-block',
        tone === 'ok' && 'border-good/25 bg-ok-soft text-good',
      )}
    >
      {title && <p className="font-semibold">{title}</p>}
      <div className={cn(title && 'mt-1 text-ink-soft')}>{children}</div>
    </div>
  )
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'quiet' | 'ok' | 'warn' | 'flag' | 'accent'
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm px-1.5 py-1 text-micro font-semibold tracking-[.07em] uppercase',
        tone === 'neutral' && 'bg-fill-strong text-ink-soft',
        tone === 'quiet' && 'bg-fill text-ink-faint',
        tone === 'ok' && 'bg-ok-soft text-good',
        tone === 'warn' && 'bg-review-tint text-review',
        tone === 'flag' && 'bg-block-tint text-block',
        tone === 'accent' && 'bg-fill-strong text-ink',
      )}
    >
      {children}
    </span>
  )
}

/** The 3-state filter above a list. Track sunken, active pill lifted. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string; count?: number }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="flex gap-0.5 rounded-lg bg-fill p-[3px]">
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-md px-3 py-[7px] text-sm transition-colors',
              active
                ? 'bg-surface font-semibold text-ink shadow-pill'
                : 'font-medium text-ink-mid hover:text-ink',
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span className="nums font-mono"> · {option.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-control bg-surface px-6 py-14 text-center">
      <p className="text-base font-semibold text-ink">{title}</p>
      {children && <div className="mt-1.5 text-sm text-ink-faint">{children}</div>}
    </div>
  )
}
