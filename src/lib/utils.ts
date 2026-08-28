import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatMoney(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value)
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
