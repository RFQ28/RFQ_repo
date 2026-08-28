'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { ConfidenceBand, MatchAlternative } from '@/lib/db/types'
import { FLAG_LABELS, flagPriority } from '@/lib/quote/draft'
import { cn, formatMoney, formatQty, pluralize } from '@/lib/utils'
import { Badge, Button, Callout } from '@/components/ui'
import { ProductPicker } from './product-picker'
import {
  acceptQuoteLine, addQuoteLine, applyQuoteMargin, changeQuoteLineMatch, claimRfq,
  deleteQuoteLine, updateQuoteLine,
} from './actions'

export type SourceLine = {
  id: string
  lineNumber: number
  rawText: string
  isParsed: boolean
  parseError: string | null
  sourceDocument: string | null
}

export type ReviewLine = {
  id: string
  lineNumber: number
  rfqLineId: string | null
  productId: string | null
  sku: string | null
  productDescription: string | null
  manufacturer: string | null
  manufacturerPartNumber: string | null
  cost: number | null
  matchConfidence: number | null
  matchBand: ConfidenceBand
  matchMethod: string | null
  matchReasoning: string | null
  alternatives: MatchAlternative[]
  requestedQty: number | null
  requestedUom: string | null
  quotedQty: number | null
  quotedUom: string | null
  uomConversionApplied: boolean
  uomConversionNote: string | null
  uomUnresolved: boolean
  listPrice: number | null
  unitPrice: number | null
  priceSource: string | null
  priceMissing: boolean
  lineMarginPercent: number | null
  marginLocked: boolean
  extendedPrice: number | null
  isSubstitution: boolean
  substitutedForText: string | null
  onHandQty: number | null
  stockShortfall: boolean
  leadTimeDays: number | null
  isFlagged: boolean
  flagReasons: string[]
  note: string | null
  isManual: boolean
}

export type ReviewQuote = {
  id: string
  rfqId: string
  quoteNumber: string | null
  status: string
  subtotal: number | null
  total: number | null
  terms: string | null
  validUntil: string | null
  deliveryNotes: string | null
  globalMarginPercent: number | null
  customerContactName: string | null
  customerContactEmail: string | null
  customerName: string | null
  jobName: string | null
  dueDate: string | null
  receivedAt: string
  deliveryAddress: string | null
  emailSubject: string | null
  emailFrom: string | null
  claimedBy: string | null
  claimedByName: string | null
}

const BAND_TONE: Record<ConfidenceBand, 'ok' | 'accent' | 'warn' | 'flag'> = {
  high: 'ok',
  medium: 'accent',
  low: 'warn',
  no_match: 'flag',
}

export function ReviewScreen({
  quote,
  lines: initialLines,
  source,
  currentUserId,
}: {
  quote: ReviewQuote
  lines: ReviewLine[]
  source: SourceLine[]
  currentUserId: string
}) {
  const router = useRouter()
  const [lines, setLines] = useState(initialLines)
  const [serverLines, setServerLines] = useState(initialLines)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [showConfirmed, setShowConfirmed] = useState(false)
  const [picker, setPicker] = useState<{ mode: 'change'; lineId: string } | { mode: 'add' } | null>(null)
  const [, startTransition] = useTransition()

  // Adjusting state during render rather than in an effect: when the server
  // sends a fresh copy after a refresh, local edits are replaced by it in the
  // same pass, with no intermediate render showing the stale rows.
  if (initialLines !== serverLines) {
    setServerLines(initialLines)
    setLines(initialLines)
  }

  const { flagged, confirmed } = useMemo(() => {
    const flaggedLines = lines
      .filter((line) => line.isFlagged)
      .sort((a, b) => flagPriority(a.flagReasons) - flagPriority(b.flagReasons) || a.lineNumber - b.lineNumber)
    return {
      flagged: flaggedLines,
      confirmed: lines.filter((line) => !line.isFlagged).sort((a, b) => a.lineNumber - b.lineNumber),
    }
  }, [lines])

  const isClaimedByMe = quote.claimedBy === currentUserId
  const isClaimedByOther = quote.claimedBy !== null && !isClaimedByMe
  const readOnly = quote.status !== 'draft' && quote.status !== 'in_review'

  const subtotal = useMemo(
    () => lines.reduce((sum, line) => sum + (line.extendedPrice ?? 0), 0),
    [lines],
  )
  const unpriced = lines.filter((line) => line.extendedPrice === null).length

  // --- saving -------------------------------------------------------------

  const save = useCallback(
    async (run: () => Promise<{ error?: string }>) => {
      setSaveState('saving')
      const result = await run()
      if (result.error) {
        setSaveState('error')
        setError(result.error)
        return false
      }
      setSaveState('saved')
      setError(null)
      return true
    },
    [],
  )

  /** Optimistic local edit plus a debounced write, so typing never stutters. */
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const editLine = useCallback(
    (lineId: string, patch: Partial<ReviewLine>, remote: Parameters<typeof updateQuoteLine>[0]) => {
      setLines((current) =>
        current.map((line) => (line.id === lineId ? recompute({ ...line, ...patch }) : line)),
      )

      const existing = pending.current.get(lineId)
      if (existing) clearTimeout(existing)

      pending.current.set(
        lineId,
        setTimeout(() => {
          pending.current.delete(lineId)
          void save(() => updateQuoteLine(remote))
        }, 600),
      )
    },
    [save],
  )

  // Flush anything still debounced when the rep leaves. Autosave that only
  // fires on a timer loses the last edit of every session.
  useEffect(() => {
    const timers = pending.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
    }
  }, [])

  // --- keyboard (6.9: reps are fast typists and resent a mouse-only UI) ----

  const ordered = useMemo(() => [...flagged, ...(showConfirmed ? confirmed : [])], [flagged, confirmed, showConfirmed])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
        if (event.key === 'Escape') target.blur()
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return

      const index = ordered.findIndex((line) => line.id === selectedId)

      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          event.preventDefault()
          setSelectedId(ordered[Math.min(index + 1, ordered.length - 1)]?.id ?? ordered[0]?.id ?? null)
          break
        case 'k':
        case 'ArrowUp':
          event.preventDefault()
          setSelectedId(ordered[Math.max(index - 1, 0)]?.id ?? null)
          break
        case 'a':
          if (selectedId && !readOnly) {
            event.preventDefault()
            void acceptLine(selectedId)
          }
          break
        case 'c':
          if (selectedId && !readOnly) {
            event.preventDefault()
            setPicker({ mode: 'change', lineId: selectedId })
          }
          break
        case '?':
          event.preventDefault()
          setShowConfirmed((v) => !v)
          break
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered, selectedId, readOnly])

  async function acceptLine(lineId: string) {
    setLines((current) =>
      current.map((line) => (line.id === lineId ? { ...line, isFlagged: false, flagReasons: [] } : line)),
    )
    await save(() => acceptQuoteLine(lineId))
  }

  async function chooseProduct(productId: string) {
    if (!picker) return
    const target = picker
    setPicker(null)

    const ok = await save(() =>
      target.mode === 'change'
        ? changeQuoteLineMatch(target.lineId, productId)
        : addQuoteLine(quote.id, productId),
    )
    if (ok) startTransition(() => router.refresh())
  }

  async function removeLine(lineId: string) {
    setLines((current) => current.filter((line) => line.id !== lineId))
    const ok = await save(() => deleteQuoteLine(lineId))
    if (!ok) startTransition(() => router.refresh())
  }

  return (
    <div className="-mx-5 -my-8">
      <Header
        quote={quote}
        subtotal={subtotal}
        unpriced={unpriced}
        flaggedCount={flagged.length}
        totalCount={lines.length}
        saveState={saveState}
        readOnly={readOnly}
        isClaimedByMe={isClaimedByMe}
        isClaimedByOther={isClaimedByOther}
        onClaim={async (force) => {
          const ok = await save(() => claimRfq(quote.rfqId, force))
          if (ok) startTransition(() => router.refresh())
        }}
        onApplyMargin={async (margin) => {
          const result = await applyQuoteMargin(quote.id, margin)
          if (result.error) {
            setError(result.error)
            return
          }
          if (result.skipped) {
            setError(
              `${result.applied} line${result.applied === 1 ? '' : 's'} repriced. ` +
                `${result.skipped} skipped — locked, or no cost in the catalogue.`,
            )
          }
          startTransition(() => router.refresh())
        }}
      />

      {error && (
        <div className="border-b border-line bg-surface px-5 py-2">
          <Callout tone="warn">{error}</Callout>
        </div>
      )}

      <div className="grid lg:grid-cols-[minmax(320px,420px)_1fr]">
        <OriginalDocument
          source={source}
          lines={lines}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />

        <div className="min-h-[70vh] px-5 py-4">
          {flagged.length > 0 ? (
            <section>
              <div className="mb-3 flex items-baseline gap-2">
                <h2 className="text-sm font-semibold text-ink">Needs you</h2>
                <span className="text-sm text-ink-faint">{pluralize(flagged.length, 'line')}</span>
              </div>
              <div className="space-y-2">
                {flagged.map((line) => (
                  <LineCard
                    key={line.id}
                    line={line}
                    selected={selectedId === line.id}
                    readOnly={readOnly}
                    onSelect={() => setSelectedId(line.id)}
                    onEdit={editLine}
                    onAccept={() => acceptLine(line.id)}
                    onChangeMatch={() => setPicker({ mode: 'change', lineId: line.id })}
                    onDelete={() => removeLine(line.id)}
                    onPickAlternative={async (productId) => {
                      const ok = await save(() => changeQuoteLineMatch(line.id, productId))
                      if (ok) startTransition(() => router.refresh())
                    }}
                  />
                ))}
              </div>
            </section>
          ) : (
            <Callout tone="ok" title="Nothing flagged">
              Every line matched, priced and converted cleanly. Spot-check below if you like.
            </Callout>
          )}

          <section className="mt-6">
            <button
              type="button"
              className="mb-3 flex items-baseline gap-2 text-sm font-semibold text-ink hover:text-accent"
              onClick={() => setShowConfirmed((v) => !v)}
            >
              <span>{showConfirmed ? '▾' : '▸'} Confirmed</span>
              <span className="font-normal text-ink-faint">{pluralize(confirmed.length, 'line')}</span>
            </button>

            {showConfirmed && (
              <div className="space-y-2">
                {confirmed.map((line) => (
                  <LineCard
                    key={line.id}
                    line={line}
                    selected={selectedId === line.id}
                    readOnly={readOnly}
                    compact
                    onSelect={() => setSelectedId(line.id)}
                    onEdit={editLine}
                    onAccept={() => acceptLine(line.id)}
                    onChangeMatch={() => setPicker({ mode: 'change', lineId: line.id })}
                    onDelete={() => removeLine(line.id)}
                    onPickAlternative={async (productId) => {
                      const ok = await save(() => changeQuoteLineMatch(line.id, productId))
                      if (ok) startTransition(() => router.refresh())
                    }}
                  />
                ))}
              </div>
            )}
          </section>

          {!readOnly && (
            <div className="mt-6">
              <Button variant="secondary" size="sm" onClick={() => setPicker({ mode: 'add' })}>
                Add a line
              </Button>
            </div>
          )}

          <p className="mt-8 text-xs text-ink-faint">
            <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> move ·{' '}
            <kbd className="font-mono">a</kbd> accept · <kbd className="font-mono">c</kbd> change match ·{' '}
            <kbd className="font-mono">?</kbd> show confirmed
          </p>
        </div>
      </div>

      {picker && (
        <ProductPicker
          title={picker.mode === 'add' ? 'Add a line' : 'Change the match'}
          onPick={chooseProduct}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}

/** Keeps the extended price honest while an edit is still only local. */
function recompute(line: ReviewLine): ReviewLine {
  const extended =
    line.unitPrice === null || line.quotedQty === null
      ? null
      : Math.round(line.unitPrice * line.quotedQty * 100) / 100
  return { ...line, extendedPrice: extended }
}

// ---------------------------------------------------------------------------

function Header({
  quote, subtotal, unpriced, flaggedCount, totalCount, saveState, readOnly,
  isClaimedByMe, isClaimedByOther, onClaim, onApplyMargin,
}: {
  quote: ReviewQuote
  subtotal: number
  unpriced: number
  flaggedCount: number
  totalCount: number
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  readOnly: boolean
  isClaimedByMe: boolean
  isClaimedByOther: boolean
  onClaim: (force: boolean) => void
  onApplyMargin: (margin: number) => void
}) {
  const [margin, setMargin] = useState(quote.globalMarginPercent?.toString() ?? '')

  return (
    <header className="sticky top-14 z-10 border-b border-line bg-surface px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold text-ink">{quote.jobName ?? 'Untitled job'}</h1>
            {quote.quoteNumber && <Badge tone="neutral">{quote.quoteNumber}</Badge>}
            {readOnly && <Badge tone="ok">{quote.status}</Badge>}
          </div>
          <p className="text-sm text-ink-soft">
            {quote.customerName ?? 'Unknown contractor'}
            {quote.dueDate && <span className="text-ink-faint"> · due {quote.dueDate}</span>}
          </p>
        </div>

        <div className="flex items-baseline gap-1.5">
          <span className="nums text-lg font-semibold text-ink">{formatMoney(subtotal)}</span>
          {unpriced > 0 && (
            <span className="text-sm text-flag">+ {pluralize(unpriced, 'unpriced line')}</span>
          )}
        </div>

        <p className="text-sm text-ink-soft">
          <span className={flaggedCount > 0 ? 'font-medium text-warn' : 'text-ok'}>
            {flaggedCount} flagged
          </span>
          <span className="text-ink-faint"> of {totalCount}</span>
        </p>

        <div className="ml-auto flex items-center gap-3">
          <span
            className={cn(
              'text-xs',
              saveState === 'saving' && 'text-ink-faint',
              saveState === 'saved' && 'text-ok',
              saveState === 'error' && 'text-flag',
              saveState === 'idle' && 'text-transparent',
            )}
          >
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved' : '·'}
          </span>

          {!readOnly && (
            <div className="flex items-center gap-1.5">
              <label htmlFor="margin" className="text-xs text-ink-soft">
                Margin
              </label>
              <input
                id="margin"
                inputMode="decimal"
                value={margin}
                onChange={(e) => setMargin(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && margin.trim() !== '') onApplyMargin(Number(margin))
                }}
                className="nums h-8 w-16 rounded-md border border-line-strong bg-surface px-2 text-sm"
                placeholder="%"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={margin.trim() === ''}
                onClick={() => onApplyMargin(Number(margin))}
              >
                Apply
              </Button>
            </div>
          )}

          {!readOnly && !isClaimedByMe && (
            <Button size="sm" onClick={() => onClaim(isClaimedByOther)}>
              {isClaimedByOther ? `Take over from ${quote.claimedByName}` : 'Claim'}
            </Button>
          )}
          {isClaimedByMe && <Badge tone="accent">Yours</Badge>}
        </div>
      </div>
    </header>
  )
}

// ---------------------------------------------------------------------------

function OriginalDocument({
  source, lines, selectedId, onSelect,
}: {
  source: SourceLine[]
  lines: ReviewLine[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const byRfqLine = useMemo(() => {
    const map = new Map<string, ReviewLine>()
    for (const line of lines) if (line.rfqLineId) map.set(line.rfqLineId, line)
    return map
  }, [lines])

  const selectedRfqLineId = lines.find((line) => line.id === selectedId)?.rfqLineId ?? null
  const documents = useMemo(() => {
    const grouped = new Map<string, SourceLine[]>()
    for (const line of source) {
      const key = line.sourceDocument ?? 'Email body'
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key)!.push(line)
    }
    return [...grouped.entries()]
  }, [source])

  return (
    <aside className="border-r border-line bg-surface lg:sticky lg:top-[7.5rem] lg:max-h-[calc(100vh-7.5rem)] lg:overflow-y-auto">
      <div className="px-5 py-4">
        <h2 className="mb-3 text-sm font-semibold text-ink">What they sent</h2>

        {documents.length === 0 && <p className="text-sm text-ink-faint">No document lines were stored.</p>}

        {documents.map(([document, docLines]) => (
          <div key={document} className="mb-5">
            <p className="mb-1.5 font-mono text-xs text-ink-faint">{document}</p>
            <ol className="space-y-0.5">
              {docLines.map((line) => {
                const quoteLine = byRfqLine.get(line.id)
                const isSelected = selectedRfqLineId === line.id
                return (
                  <li key={line.id}>
                    <button
                      type="button"
                      onClick={() => quoteLine && onSelect(quoteLine.id)}
                      className={cn(
                        'w-full rounded px-2 py-1 text-left font-mono text-xs leading-relaxed transition-colors',
                        isSelected ? 'bg-accent-soft text-ink' : 'text-ink-soft hover:bg-canvas',
                        !line.isParsed && 'text-flag',
                      )}
                    >
                      <span className="mr-2 text-ink-faint">{line.lineNumber}</span>
                      {line.rawText}
                      {!line.isParsed && line.parseError && (
                        <span className="mt-0.5 block font-sans text-[11px] text-flag">
                          {line.parseError}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ol>
          </div>
        ))}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------

function LineCard({
  line, selected, readOnly, compact, onSelect, onEdit, onAccept, onChangeMatch, onDelete, onPickAlternative,
}: {
  line: ReviewLine
  selected: boolean
  readOnly: boolean
  compact?: boolean
  onSelect: () => void
  onEdit: (id: string, patch: Partial<ReviewLine>, remote: Parameters<typeof updateQuoteLine>[0]) => void
  onAccept: () => void
  onChangeMatch: () => void
  onDelete: () => void
  onPickAlternative: (productId: string) => void
}) {
  const [showWhy, setShowWhy] = useState(false)

  return (
    <article
      onClick={onSelect}
      className={cn(
        'rounded-lg border bg-surface transition-colors',
        selected ? 'border-accent ring-1 ring-accent/20' : 'border-line hover:border-line-strong',
      )}
    >
      <div className={cn('px-3', compact ? 'py-2' : 'py-3')}>
        <div className="flex items-start gap-3">
          <span className="nums mt-0.5 w-6 shrink-0 text-xs text-ink-faint">{line.lineNumber}</span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {line.productId ? (
                <>
                  <span className="font-mono text-xs text-ink-soft">{line.sku}</span>
                  <span className="text-sm font-medium text-ink">{line.productDescription}</span>
                </>
              ) : (
                <span className="text-sm font-medium text-flag">No product matched</span>
              )}
              <Badge tone={BAND_TONE[line.matchBand]}>
                {line.matchBand === 'no_match' ? 'no match' : line.matchBand}
              </Badge>
              {line.isSubstitution && <Badge tone="warn">substitution</Badge>}
              {line.isManual && <Badge tone="neutral">added</Badge>}
            </div>

            {line.isSubstitution && line.substitutedForText && (
              <p className="mt-0.5 text-xs text-warn">
                They asked for {line.substitutedForText}
              </p>
            )}

            {line.flagReasons.length > 0 && (
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                {line.flagReasons.map((reason) => (
                  <li key={reason} className="text-xs text-warn">
                    {FLAG_LABELS[reason] ?? reason}
                  </li>
                ))}
              </ul>
            )}

            {line.uomConversionNote && (
              <p className="mt-1 text-xs text-ink-soft">{line.uomConversionNote}</p>
            )}
          </div>

          <div className="shrink-0 text-right">
            <p className="nums text-sm font-medium text-ink">{formatMoney(line.extendedPrice)}</p>
            {line.lineMarginPercent !== null && (
              <p className="nums text-xs text-ink-faint">{line.lineMarginPercent}% margin</p>
            )}
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 pl-9">
          <Field
            label="Qty"
            value={line.quotedQty === null ? '' : String(line.quotedQty)}
            width="w-20"
            disabled={readOnly}
            onCommit={(value) => {
              const qty = value === '' ? null : Number(value)
              if (qty !== null && !Number.isFinite(qty)) return
              onEdit(line.id, { quotedQty: qty }, { quoteLineId: line.id, quotedQty: qty })
            }}
          />
          <Field
            label="Unit"
            value={line.quotedUom ?? ''}
            width="w-16"
            disabled={readOnly}
            onCommit={(value) =>
              onEdit(line.id, { quotedUom: value || null }, { quoteLineId: line.id, quotedUom: value || null })
            }
          />
          <Field
            label="Price"
            value={line.unitPrice === null ? '' : String(line.unitPrice)}
            width="w-24"
            disabled={readOnly}
            onCommit={(value) => {
              const price = value === '' ? null : Number(value)
              if (price !== null && !Number.isFinite(price)) return
              onEdit(line.id, { unitPrice: price }, { quoteLineId: line.id, unitPrice: price })
            }}
          />

          {line.requestedQty !== null &&
            (line.requestedQty !== line.quotedQty || line.requestedUom !== line.quotedUom) && (
              <span className="nums text-xs text-ink-faint">
                asked for {formatQty(line.requestedQty)} {line.requestedUom}
              </span>
            )}

          {line.onHandQty !== null && (
            <span className={cn('nums text-xs', line.stockShortfall ? 'text-flag' : 'text-ink-faint')}>
              {formatQty(line.onHandQty)} on hand
              {line.leadTimeDays ? ` · ${line.leadTimeDays}d lead` : ''}
            </span>
          )}

          <button
            type="button"
            className="text-xs text-ink-faint underline-offset-2 hover:text-ink hover:underline"
            onClick={(e) => {
              e.stopPropagation()
              setShowWhy((v) => !v)
            }}
          >
            why
          </button>

          {!readOnly && (
            <div className="ml-auto flex items-center gap-1.5">
              {line.isFlagged && (
                <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); onAccept() }}>
                  Accept
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onChangeMatch() }}>
                Change
              </Button>
              <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onDelete() }}>
                Delete
              </Button>
            </div>
          )}
        </div>

        {showWhy && (
          <div className="mt-2 ml-9 rounded-md bg-canvas px-3 py-2 text-xs text-ink-soft">
            <p>
              <span className="font-medium text-ink">Match:</span> {line.matchReasoning ?? '—'}
              {line.matchConfidence !== null && (
                <span className="text-ink-faint"> ({Math.round(line.matchConfidence * 100)}%)</span>
              )}
            </p>
            <p className="mt-0.5">
              <span className="font-medium text-ink">Price:</span>{' '}
              {line.priceMissing ? 'No price could be derived' : describePrice(line)}
            </p>
            {line.uomConversionNote && (
              <p className="mt-0.5">
                <span className="font-medium text-ink">Quantity:</span> {line.uomConversionNote}
              </p>
            )}

            {line.alternatives.length > 0 && (
              <div className="mt-2">
                <p className="font-medium text-ink">Other candidates</p>
                <ul className="mt-1 space-y-1">
                  {line.alternatives.map((alt) => (
                    <li key={alt.product_id} className="flex items-center gap-2">
                      <span className="font-mono">{alt.sku}</span>
                      <span className="truncate text-ink-faint">{alt.description}</span>
                      <span className="nums text-ink-faint">{Math.round(alt.confidence * 100)}%</span>
                      {!readOnly && (
                        <button
                          type="button"
                          className="ml-auto shrink-0 text-accent hover:underline"
                          onClick={(e) => { e.stopPropagation(); onPickAlternative(alt.product_id) }}
                        >
                          use this
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  )
}

function describePrice(line: ReviewLine): string {
  const source =
    line.priceSource === 'list_no_rule' ? 'List price — no customer rule found'
    : line.priceSource === 'manual' ? 'Set by hand'
    : line.priceSource ? `From the ${line.priceSource.replace(/_/g, ' ')} rule`
    : 'Unknown'
  const list = line.listPrice !== null ? ` · list ${formatMoney(line.listPrice)}` : ''
  return `${source}${list}`
}

/** An input that only reports upward when the rep is done with it. */
function Field({
  label, value, width, disabled, onCommit,
}: {
  label: string
  value: string
  width: string
  disabled?: boolean
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const [lastValue, setLastValue] = useState(value)

  // A saved edit comes back down as a new `value`; the draft follows it.
  if (value !== lastValue) {
    setLastValue(value)
    setDraft(value)
  }

  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-soft">
      {label}
      <input
        value={draft}
        disabled={disabled}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            setDraft(value)
            e.currentTarget.blur()
          }
        }}
        className={cn(
          'nums h-7 rounded border border-line-strong bg-surface px-1.5 text-xs text-ink',
          'disabled:bg-canvas disabled:text-ink-faint',
          width,
        )}
      />
    </label>
  )
}
