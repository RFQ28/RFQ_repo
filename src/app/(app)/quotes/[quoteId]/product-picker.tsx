'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { searchProducts, type ProductSearchResult } from './actions'
import { cn, formatMoney, formatQty } from '@/lib/utils'

/**
 * The catalogue picker (6.9).
 *
 * Opens focused, searches as you type, and is driven entirely from the
 * keyboard: arrows move, Enter picks, Escape closes. A rep changing a match is
 * the most common correction they make, so it must not cost them a mouse trip.
 */
export function ProductPicker({
  title,
  onPick,
  onClose,
}: {
  title: string
  onPick: (productId: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ProductSearchResult[]>([])
  const [highlighted, setHighlighted] = useState(0)
  const [searching, startSearch] = useTransition()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Below two characters there is nothing to show, so the list is derived
  // rather than cleared — one less piece of state to keep in step.
  const visible = query.trim().length < 2 ? [] : results

  useEffect(() => {
    if (query.trim().length < 2) return
    const timer = setTimeout(() => {
      startSearch(async () => {
        const found = await searchProducts(query)
        setResults(found)
        setHighlighted(0)
      })
    }, 200)
    return () => clearTimeout(timer)
  }, [query])

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlighted((i) => Math.min(i + 1, visible.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlighted((i) => Math.max(i - 1, 0))
    } else if (event.key === 'Enter' && visible[highlighted]) {
      event.preventDefault()
      onPick(visible[highlighted].id)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 px-4 pt-[12vh]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-line bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-4 py-3">
          <p className="mb-2 text-sm font-medium text-ink">{title}</p>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="SKU, part number, or description"
            className="h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
        </div>

        <div className="max-h-[50vh] overflow-y-auto">
          {query.trim().length < 2 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-faint">
              Type at least two characters.
            </p>
          ) : searching && visible.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-faint">Searching…</p>
          ) : visible.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-faint">
              Nothing in the catalogue matches that.
            </p>
          ) : (
            <ul>
              {visible.map((product, index) => (
                <li key={product.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlighted(index)}
                    onClick={() => onPick(product.id)}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-2 text-left',
                      index === highlighted ? 'bg-accent-soft' : 'hover:bg-canvas',
                    )}
                  >
                    <span className="w-32 shrink-0 truncate font-mono text-xs text-ink-soft">
                      {product.sku}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">{product.description}</span>
                      {(product.manufacturer || product.manufacturerPartNumber) && (
                        <span className="block truncate text-xs text-ink-faint">
                          {[product.manufacturer, product.manufacturerPartNumber].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </span>
                    <span className="nums shrink-0 text-right text-xs">
                      <span className="block text-ink">{formatMoney(product.listPrice)}</span>
                      <span className="block text-ink-faint">
                        {product.onHand === null ? '—' : `${formatQty(product.onHand)} ${product.uom}`}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-line px-4 py-2 text-xs text-ink-faint">
          <kbd className="font-mono">↑↓</kbd> move · <kbd className="font-mono">enter</kbd> choose ·{' '}
          <kbd className="font-mono">esc</kbd> close
        </div>
      </div>
    </div>
  )
}
