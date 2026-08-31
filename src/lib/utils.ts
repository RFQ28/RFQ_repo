import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * Our type scale adds three sizes on top of Tailwind's defaults. tailwind-merge
 * only knows the defaults, so it reads `text-micro` as a *colour* and lets a
 * later `text-ink-dim` in the same `cn()` delete it — which silently returned
 * eyebrows and badges to 16px. Teaching it the three names fixes that.
 */
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['micro', '2xs', 'md'] }] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatMoney(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value)
}

/**
 * A price as it belongs in an editable field: two decimals, no symbol.
 *
 * Rule-derived prices carry four (`list * 0.78` on $16.80 is 13.104), and a
 * rep reading "13.104" in a box they are about to edit reads it as a mistake.
 * Quotes go out in cents, so cents is what the field shows.
 */
export function formatPriceInput(value: number | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value.toFixed(2)
}

export function formatQty(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  // Quantities are whole far more often than not; trailing .0000 is noise.
  return Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`
}
