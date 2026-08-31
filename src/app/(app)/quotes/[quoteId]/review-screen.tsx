'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { GROUPS, dueRelative, type GroupKey } from '@/lib/quote/triage'
import { cn, formatMoney, pluralize } from '@/lib/utils'
import { Badge, Button, Callout, Card, Eyebrow, KeyCap, MonoTag, Segmented } from '@/components/ui'
import { ProductPicker } from './product-picker'
import { TriagePane } from './triage'
import {
  EDGE, IssueList, LineContext, LineFields, Money, PILL, SEVERITY_BG, type EditHandler,
} from './line-bits'
import {
  countLines, decorate, recompute,
  type Counts, type DecoratedLine, type ReviewLine, type ReviewQuote, type SourceLine,
} from './model'
import {
  acceptQuoteLine, addQuoteLine, applyQuoteMargin, changeQuoteLineMatch, claimRfq,
  deleteQuoteLine, updateQuoteLine,
} from './actions'

export type { ReviewLine, ReviewQuote, SourceLine } from './model'

type Filter = 'needs' | 'priced' | 'all'

/** Beyond this many rows in one group, the tail is folded away behind a link. */
const GROUP_PREVIEW = 8

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
  const [filter, setFilter] = useState<Filter>('needs')
  const [collapsed, setCollapsed] = useState<Set<GroupKey>>(() => new Set())
  const [expanded, setExpanded] = useState<Set<GroupKey>>(() => new Set())
  const [picker, setPicker] = useState<{ mode: 'change'; lineId: string } | { mode: 'add' } | null>(null)
  const [triage, setTriage] = useState<{ ids: string[]; cursor: number } | null>(null)
  // Desktop-only tool: above 1180px the source pane is always there, below it
  // the rep opens it when they need to check what the contractor actually sent.
  const [sourceOpen, setSourceOpen] = useState(false)
  const [, startTransition] = useTransition()

  // Adjusting state during render rather than in an effect: when the server
  // sends a fresh copy after a refresh, local edits are replaced by it in the
  // same pass, with no intermediate render showing the stale rows.
  if (initialLines !== serverLines) {
    setServerLines(initialLines)
    setLines(initialLines)
  }

  const decorated = useMemo(() => lines.map(decorate), [lines])
  const counts = useMemo(() => countLines(decorated), [decorated])

  const subtotal = useMemo(
    () => decorated.reduce((sum, line) => sum + (line.extendedPrice ?? 0), 0),
    [decorated],
  )

  const isClaimedByMe = quote.claimedBy === currentUserId
  const isClaimedByOther = quote.claimedBy !== null && !isClaimedByMe
  const readOnly = quote.status !== 'draft' && quote.status !== 'in_review'

  const sourceByRfqLine = useMemo(() => {
    const map = new Map<string, SourceLine>()
    for (const line of source) map.set(line.id, line)
    return map
  }, [source])

  // --- saving -------------------------------------------------------------

  const save = useCallback(async (run: () => Promise<{ error?: string }>) => {
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
  }, [])

  /** Optimistic local edit plus a debounced write, so typing never stutters. */
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const editLine: EditHandler = useCallback(
    (lineId, patch, remote) => {
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

  // --- what the list shows ------------------------------------------------

  const visible = useMemo(() => {
    const byNumber = (a: DecoratedLine, b: DecoratedLine) => a.lineNumber - b.lineNumber
    if (filter === 'priced') return decorated.filter((line) => !line.isFlagged).sort(byNumber)
    if (filter === 'all') return [...decorated].sort(byNumber)
    return decorated.filter((line) => line.isFlagged).sort(byNumber)
  }, [decorated, filter])

  /** "Needs you" is grouped by cause: eight lead times clear in one pass. */
  const grouped = useMemo(() => {
    const buckets = new Map<GroupKey, DecoratedLine[]>()
    for (const line of visible) {
      const bucket = buckets.get(line.group)
      if (bucket) bucket.push(line)
      else buckets.set(line.group, [line])
    }
    return GROUPS.filter((group) => buckets.has(group.key)).map((group) => ({
      ...group,
      lines: buckets.get(group.key)!,
    }))
  }, [visible])

  const flaggedInOrder = useMemo(
    () =>
      decorated
        .filter((line) => line.isFlagged)
        .sort(
          (a, b) =>
            GROUPS.findIndex((g) => g.key === a.group) - GROUPS.findIndex((g) => g.key === b.group) ||
            a.lineNumber - b.lineNumber,
        ),
    [decorated],
  )

  // --- actions ------------------------------------------------------------

  const acceptLine = useCallback(
    async (lineId: string) => {
      setLines((current) =>
        current.map((line) => (line.id === lineId ? { ...line, isFlagged: false, flagReasons: [] } : line)),
      )
      await save(() => acceptQuoteLine(lineId))
    },
    [save],
  )

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

  const removeLine = useCallback(
    async (lineId: string) => {
      setLines((current) => current.filter((line) => line.id !== lineId))
      const ok = await save(() => deleteQuoteLine(lineId))
      if (!ok) startTransition(() => router.refresh())
    },
    [save, router],
  )

  // --- keyboard, list mode (reps are fast typists and resent a mouse) -----

  useEffect(() => {
    if (triage) return
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
        if (event.key === 'Escape') target.blur()
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return

      const index = visible.findIndex((line) => line.id === selectedId)

      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          event.preventDefault()
          setSelectedId(visible[Math.min(index + 1, visible.length - 1)]?.id ?? visible[0]?.id ?? null)
          break
        case 'k':
        case 'ArrowUp':
          event.preventDefault()
          setSelectedId(visible[Math.max(index - 1, 0)]?.id ?? null)
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
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, selectedId, readOnly, triage, acceptLine])

  const triageQueue = useMemo(() => {
    if (!triage) return []
    const byId = new Map(decorated.map((line) => [line.id, line]))
    return triage.ids.map((id) => byId.get(id)).filter((line): line is DecoratedLine => Boolean(line))
  }, [triage, decorated])

  return (
    <>
      <Card>
        <QuoteHeader
          quote={quote}
          counts={counts}
          subtotal={subtotal}
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
            const applied = result.applied ?? 0
            setError(
              result.skipped
                ? `Applied ${margin}% to ${pluralize(applied, 'line')}. ` +
                    `${result.skipped} skipped — locked, or no cost in the catalogue.`
                : `Applied ${margin}% to ${pluralize(applied, 'line')}.`,
            )
            startTransition(() => router.refresh())
          }}
        />

        {error && (
          <div className="border-b border-line px-6 py-3">
            <Callout tone="warn">{error}</Callout>
          </div>
        )}

        <div className="flex items-center gap-3 border-b border-line px-6 py-3">
          {triage ? (
            <>
              <Button variant="secondary" size="sm" onClick={() => setTriage(null)}>
                Back to the list
              </Button>
              <span className="text-xs text-ink-dim">
                Reviewing {pluralize(triageQueue.length, 'flagged line')}, one at a time.
              </span>
            </>
          ) : (
            <>
              <Segmented<Filter>
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'needs', label: 'Needs you', count: counts.flagged },
                  { value: 'priced', label: 'Priced', count: counts.total - counts.flagged },
                  { value: 'all', label: 'All', count: counts.total },
                ]}
              />
              {counts.flagged > 0 && !readOnly && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setTriage({ ids: flaggedInOrder.map((line) => line.id), cursor: 0 })
                  }
                >
                  Review flagged lines
                </Button>
              )}
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                className="min-[1180px]:hidden"
                onClick={() => setSourceOpen((v) => !v)}
              >
                {sourceOpen ? 'Hide what they sent' : 'What they sent'}
              </Button>
              <SaveState state={saveState} />
              <span className="text-xs text-ink-dim">
                {filter === 'needs' ? 'Grouped by cause, then line no.' : 'Sorted by line no.'}
              </span>
            </>
          )}
        </div>

        {triage ? (
          <TriagePane
            queue={triageQueue}
            sourceByRfqLine={sourceByRfqLine}
            readOnly={readOnly}
            cursor={Math.min(triage.cursor, Math.max(triageQueue.length - 1, 0))}
            onCursor={(cursor) => setTriage((t) => (t ? { ...t, cursor } : t))}
            onEdit={editLine}
            onAccept={acceptLine}
            onSwap={(lineId) => setPicker({ mode: 'change', lineId })}
            onDelete={removeLine}
            onExit={() => setTriage(null)}
          />
        ) : (
          <div className="flex">
            <SourcePane
              source={source}
              lines={decorated}
              open={sourceOpen}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />

            <div className="min-w-0 flex-1">
              {visible.length === 0 ? (
                <div className="px-6 py-16 text-center">
                  <p className="text-base font-semibold text-ink">
                    {filter === 'needs' ? 'Nothing needs you' : 'No lines here'}
                  </p>
                  <p className="mt-1.5 text-sm text-ink-faint">
                    {filter === 'needs'
                      ? 'Every line matched, priced and converted cleanly. Spot-check under “All” if you like.'
                      : 'Try another filter.'}
                  </p>
                </div>
              ) : filter === 'needs' ? (
                grouped.map((group) => {
                  const isCollapsed = collapsed.has(group.key)
                  const isExpanded = expanded.has(group.key)
                  const shown = isExpanded ? group.lines : group.lines.slice(0, GROUP_PREVIEW)
                  const hidden = group.lines.length - shown.length

                  return (
                    <section key={group.key}>
                      <button
                        type="button"
                        onClick={() =>
                          setCollapsed((current) => {
                            const next = new Set(current)
                            if (next.has(group.key)) next.delete(group.key)
                            else next.add(group.key)
                            return next
                          })
                        }
                        className="flex w-full items-center gap-2.5 border-b border-line bg-sunken px-6 py-3.5 text-left transition-colors hover:bg-fill"
                      >
                        <i
                          aria-hidden
                          className={cn('block size-[7px] rounded-[2px]', SEVERITY_BG[group.severity])}
                        />
                        <span className="text-sm font-semibold text-ink">{group.label}</span>
                        <span className="nums font-mono text-xs font-medium text-ink-dim">
                          {group.lines.length}
                        </span>
                        <div className="flex-1" />
                        <span className="text-[11px] text-ink-dim">
                          {isCollapsed ? 'show' : group.hint}
                        </span>
                      </button>

                      {!isCollapsed &&
                        shown.map((line) => (
                          <LineRow
                            key={line.id}
                            line={line}
                            rawText={rawTextOf(line, sourceByRfqLine)}
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

                      {!isCollapsed && hidden > 0 && (
                        <div className="border-b border-line-soft px-6 py-4 text-center">
                          <button
                            type="button"
                            onClick={() => setExpanded((c) => new Set(c).add(group.key))}
                            className="text-sm font-medium text-ink-faint hover:text-ink"
                          >
                            {pluralize(hidden, 'more line')} in this group · show all{' '}
                            {group.lines.length}
                          </button>
                        </div>
                      )}
                    </section>
                  )
                })
              ) : (
                visible.map((line) => (
                  <LineRow
                    key={line.id}
                    line={line}
                    rawText={rawTextOf(line, sourceByRfqLine)}
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
                ))
              )}

              <div className="flex items-center gap-4 px-6 py-4">
                {!readOnly && (
                  <Button variant="ghost" size="sm" onClick={() => setPicker({ mode: 'add' })}>
                    + Add a line
                  </Button>
                )}
                <div className="flex-1" />
                <p className="flex items-center gap-1.5 text-[11px] text-ink-dim">
                  <KeyCap>j</KeyCap>
                  <KeyCap>k</KeyCap> move · <KeyCap>a</KeyCap> accept · <KeyCap>c</KeyCap> change match
                </p>
              </div>
            </div>
          </div>
        )}
      </Card>

      {picker && (
        <ProductPicker
          title={picker.mode === 'add' ? 'Add a line' : 'Change the match'}
          onPick={chooseProduct}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------

function QuoteHeader({
  quote, counts, subtotal, readOnly, isClaimedByMe, isClaimedByOther, onClaim, onApplyMargin,
}: {
  quote: ReviewQuote
  counts: Counts
  subtotal: number
  readOnly: boolean
  isClaimedByMe: boolean
  isClaimedByOther: boolean
  onClaim: (force: boolean) => void
  onApplyMargin: (margin: number) => void
}) {
  const [margin, setMargin] = useState(quote.globalMarginPercent?.toString() ?? '')
  const left = dueRelative(quote.dueDate)
  const late = left?.endsWith('late') || left === 'due today'

  return (
    <div className="border-b border-line bg-sunken px-6 pt-[22px] pb-[18px]">
      <div className="flex flex-wrap items-start gap-8">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-[-.02em] text-ink">
              {quote.jobName ?? 'Untitled job'}
            </h1>
            {quote.quoteNumber && <MonoTag>{quote.quoteNumber}</MonoTag>}
            {readOnly && <Badge tone="ok">{quote.status.replace('_', ' ')}</Badge>}
          </div>
          <div className="text-sm text-ink-faint">
            {quote.customerName ?? 'Unknown contractor'}
            {quote.dueDate && (
              <>
                {' · due '}
                <span className="nums font-mono text-xs text-ink-mid">{quote.dueDate}</span>
                {left && <span className={cn(late && 'text-review')}> · {left}</span>}
              </>
            )}
          </div>
        </div>

        <div>
          <Eyebrow className="mb-1.5 font-normal">Quoted so far</Eyebrow>
          <div className="flex items-baseline gap-2.5">
            <span className="nums font-mono text-3xl font-semibold tracking-[-.02em] text-ink">
              {formatMoney(subtotal)}
            </span>
            {counts.unpriced > 0 && (
              <span className="text-xs font-medium text-unpriced">+{counts.unpriced} unpriced</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 self-center">
          {!readOnly && (
            <div className="flex items-center overflow-hidden rounded-lg border border-control bg-surface">
              <label htmlFor="margin" className="pr-1 pl-2.5 text-xs text-ink-faint">
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
                placeholder="18"
                className="nums w-11 border-0 bg-transparent px-0.5 py-[9px] font-mono text-sm font-medium text-ink outline-none placeholder:text-ink-pale"
              />
              <span className="pr-2 text-sm text-ink-faint">%</span>
              <button
                type="button"
                disabled={margin.trim() === ''}
                onClick={() => onApplyMargin(Number(margin))}
                className="border-l border-line px-3 py-[9px] text-sm font-semibold text-ink transition-colors hover:bg-fill disabled:text-ink-pale"
              >
                Apply
              </button>
            </div>
          )}

          {!readOnly && !isClaimedByMe && (
            <Button onClick={() => onClaim(isClaimedByOther)}>
              {isClaimedByOther ? `Take over from ${quote.claimedByName}` : 'Claim quote'}
            </Button>
          )}
          {isClaimedByMe && <Badge tone="accent">Yours</Badge>}
        </div>
      </div>

      <Progress counts={counts} />
    </div>
  )
}

/** Priced / needs review / blocked, as a share of the whole quote. */
function Progress({ counts }: { counts: Counts }) {
  const total = Math.max(counts.total, 1)
  const pct = (n: number) => `${(n / total) * 100}%`
  const legend = [
    { label: `${counts.priced} priced`, className: 'bg-good-bar', width: pct(counts.priced) },
    { label: `${counts.review} need review`, className: 'bg-review-bar', width: pct(counts.review) },
    { label: `${counts.blocked} blocked`, className: 'bg-block-bar', width: pct(counts.blocked) },
  ]

  return (
    <div className="mt-[18px] flex items-center gap-3.5">
      <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-fill-strong">
        {legend.map((segment) => (
          <div
            key={segment.label}
            className={cn('transition-[width] duration-[240ms] ease-desk', segment.className)}
            style={{ width: segment.width }}
          />
        ))}
      </div>
      <div className="flex gap-4 text-xs font-medium text-ink-mid">
        {legend.map((segment) => (
          <span key={segment.label} className="flex items-center gap-1.5">
            <i aria-hidden className={cn('block size-[7px] rounded-[2px]', segment.className)} />
            {segment.label}
          </span>
        ))}
      </div>
    </div>
  )
}

function SaveState({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (state === 'idle') return null
  return (
    <span
      className={cn(
        'text-xs',
        state === 'saving' && 'text-ink-dim',
        state === 'saved' && 'text-good',
        state === 'error' && 'text-block',
      )}
    >
      {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Not saved'}
    </span>
  )
}

// ---------------------------------------------------------------------------

function SourcePane({
  source, lines, open, selectedId, onSelect,
}: {
  source: SourceLine[]
  lines: DecoratedLine[]
  open: boolean
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const byRfqLine = useMemo(() => {
    const map = new Map<string, DecoratedLine>()
    for (const line of lines) if (line.rfqLineId) map.set(line.rfqLineId, line)
    return map
  }, [lines])

  const selectedRfqLineId = lines.find((line) => line.id === selectedId)?.rfqLineId ?? null

  const documents = useMemo(() => {
    const grouped = new Map<string, SourceLine[]>()
    for (const line of source) {
      const key = line.sourceDocument ?? 'Email body'
      const bucket = grouped.get(key)
      if (bucket) bucket.push(line)
      else grouped.set(key, [line])
    }
    return [...grouped.entries()]
  }, [source])

  return (
    <aside
      className={cn(
        'w-[296px] shrink-0 border-r border-line bg-sunken px-[22px] py-5',
        open ? 'block' : 'hidden min-[1180px]:block',
      )}
    >
      <Eyebrow className="mb-3.5">What they sent</Eyebrow>

      {documents.length === 0 && <p className="text-xs text-ink-dim">No document lines were stored.</p>}

      {documents.map(([document, docLines]) => {
        const unreadable = docLines.filter((line) => !line.isParsed && line.parseError)
        return (
          <div key={document} className="mb-5">
            <div className="flex items-center gap-2 rounded-[7px] border border-line bg-surface px-2.5 py-2 font-mono text-xs font-medium text-ink">
              <span className="truncate">{document}</span>
              <span className="ml-auto shrink-0 font-normal text-ink-dim">{docLines.length} lines</span>
            </div>

            <div className="mt-2.5 flex flex-col gap-px">
              {docLines
                .filter((line) => line.isParsed || !line.parseError)
                .map((line) => {
                  const quoteLine = byRfqLine.get(line.id)
                  const isSelected = selectedRfqLineId === line.id
                  return (
                    <button
                      key={line.id}
                      type="button"
                      disabled={!quoteLine}
                      onClick={() => quoteLine && onSelect(quoteLine.id)}
                      className={cn(
                        'grid grid-cols-[22px_1fr] gap-2 rounded-[5px] px-2.5 py-[5px] text-left transition-colors',
                        isSelected ? 'bg-fill-strong' : 'hover:bg-fill',
                      )}
                    >
                      <span className="nums text-right font-mono text-2xs text-ink-faint">
                        {line.lineNumber}
                      </span>
                      <span className="font-mono text-xs leading-[1.5] text-ink-soft">
                        {line.rawText}
                      </span>
                    </button>
                  )
                })}
            </div>

            {unreadable.map((line) => (
              <div
                key={line.id}
                className="mt-4 rounded-lg border border-dashed border-block-edge bg-block-tint/50 px-3 py-[11px]"
              >
                <div className="mb-1.5 font-mono text-xs font-medium text-ink">
                  line {line.lineNumber}
                </div>
                <div className="text-xs leading-[1.5] text-block">{line.parseError}</div>
              </div>
            ))}
          </div>
        )
      })}
    </aside>
  )
}

// ---------------------------------------------------------------------------

/** What the contractor actually typed, for lines the matcher could not place. */
function rawTextOf(line: DecoratedLine, source: Map<string, SourceLine>): string | null {
  return (line.rfqLineId ? source.get(line.rfqLineId)?.rawText : null) ?? null
}

function LineRow({
  line, rawText, selected, readOnly, onSelect, onEdit, onAccept, onChangeMatch, onDelete, onPickAlternative,
}: {
  line: DecoratedLine
  rawText: string | null
  selected: boolean
  readOnly: boolean
  onSelect: () => void
  onEdit: EditHandler
  onAccept: () => void
  onChangeMatch: () => void
  onDelete: () => void
  onPickAlternative: (productId: string) => void
}) {
  const [showWhy, setShowWhy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // A line the parser marked "no price" cannot be accepted with the box empty:
  // accepting it would quietly leave the total short.
  const acceptBlocked = line.priceMissing && line.unitPrice === null

  return (
    <article
      onClick={onSelect}
      className="grid grid-cols-[4px_1fr] border-b border-line-soft"
    >
      <div className={cn(EDGE[line.priority])} />
      <div
        className={cn(
          'px-6 pt-4 pb-[15px] transition-colors',
          selected ? 'bg-fill' : 'hover:bg-[rgba(20,22,28,.03)]',
        )}
      >
        <div className="flex items-start gap-3">
          <span className="nums w-[22px] shrink-0 pt-0.5 font-mono text-[11px] font-medium text-ink-ghost">
            {line.lineNumber}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              {line.sku && (
                <span className="font-mono text-[11px] font-medium text-ink-faint">{line.sku}</span>
              )}
              <span
                className={cn(
                  'text-md font-semibold tracking-[-.005em]',
                  line.productId ? 'text-ink' : 'text-block',
                )}
              >
                {line.productDescription ?? rawText ?? 'No product matched'}
              </span>
              {line.isFlagged && (
                <span
                  className={cn(
                    'rounded-sm px-1.5 py-1 text-micro font-semibold tracking-[.07em] uppercase',
                    PILL[line.priority],
                  )}
                >
                  {line.priority}
                </span>
              )}
              {line.isManual && <Badge tone="quiet">added</Badge>}
            </div>

            <IssueList line={line} />

            {line.explanation && (
              <div className="mt-[7px] max-w-[600px] text-sm text-pretty text-ink-mid">
                {line.explanation}
              </div>
            )}
          </div>

          <div className="shrink-0">
            <Money line={line} />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3 pl-[34px]">
          <div className="flex items-center gap-3.5">
            <LineFields line={line} variant="underline" readOnly={readOnly} onEdit={onEdit} />
          </div>

          <LineContext line={line} />

          <div className="flex-1" />

          <button
            type="button"
            className="text-xs font-medium text-ink-faint underline decoration-dotted underline-offset-[3px] hover:text-ink"
            onClick={(e) => {
              e.stopPropagation()
              setShowWhy((v) => !v)
            }}
          >
            why?
          </button>

          {!readOnly && (
            <>
              <div className="relative">
                <button
                  type="button"
                  aria-label="More actions"
                  aria-expanded={menuOpen}
                  className="rounded-[7px] px-2.5 py-2 text-sm font-medium text-ink-faint transition-colors hover:bg-fill-strong hover:text-ink"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuOpen((v) => !v)
                  }}
                >
                  ⋯
                </button>
                {menuOpen && (
                  <div
                    className="absolute right-0 bottom-full z-20 mb-1 w-52 rounded-lg border border-line bg-surface p-1 shadow-card"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p className="px-2.5 py-2 text-xs text-ink-faint">
                      Remove line {line.lineNumber} from the quote?
                    </p>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setMenuOpen(false)}>
                        Keep it
                      </Button>
                      <Button variant="danger" size="sm" onClick={onDelete}>
                        Delete line
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation()
                  onChangeMatch()
                }}
              >
                Change
              </Button>

              {line.isFlagged && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={acceptBlocked}
                  title={acceptBlocked ? 'Enter a unit price first.' : undefined}
                  className="px-4"
                  onClick={(e) => {
                    e.stopPropagation()
                    onAccept()
                  }}
                >
                  Accept
                </Button>
              )}
            </>
          )}
        </div>

        {showWhy && (
          <WhyPanel line={line} readOnly={readOnly} onPickAlternative={onPickAlternative} />
        )}
      </div>
    </article>
  )
}

/** The parser's reasoning: which rule fired, how sure it was, what else fit. */
function WhyPanel({
  line, readOnly, onPickAlternative,
}: {
  line: DecoratedLine
  readOnly: boolean
  onPickAlternative: (productId: string) => void
}) {
  return (
    <div className="mt-3 ml-[34px] rounded-[10px] border border-line bg-sunken px-4 py-3 text-xs text-ink-mid">
      <dl className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-1.5">
        <dt className="font-medium text-ink">Match</dt>
        <dd>
          {line.matchReasoning ?? '—'}
          {line.matchConfidence !== null && (
            <span className="nums text-ink-dim"> ({Math.round(line.matchConfidence * 100)}%)</span>
          )}
        </dd>
        <dt className="font-medium text-ink">Price</dt>
        <dd>{line.priceMissing ? 'No price could be derived' : describePrice(line)}</dd>
        {line.uomConversionNote && (
          <>
            <dt className="font-medium text-ink">Quantity</dt>
            <dd>{line.uomConversionNote}</dd>
          </>
        )}
      </dl>

      {line.alternatives.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <Eyebrow className="mb-2">Other candidates</Eyebrow>
          <ul className="space-y-1.5">
            {line.alternatives.map((alt) => (
              <li key={alt.product_id} className="flex items-center gap-3">
                <span className="w-28 shrink-0 truncate font-mono text-ink-faint">{alt.sku}</span>
                <span className="min-w-0 flex-1 truncate">{alt.description}</span>
                <span className="nums font-mono text-ink-dim">
                  {Math.round(alt.confidence * 100)}%
                </span>
                {!readOnly && (
                  <button
                    type="button"
                    className="shrink-0 font-medium text-ink underline underline-offset-2"
                    onClick={(e) => {
                      e.stopPropagation()
                      onPickAlternative(alt.product_id)
                    }}
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
  )
}

function describePrice(line: DecoratedLine): string {
  const source =
    line.priceSource === 'list_no_rule' ? 'List price — no customer rule found'
    : line.priceSource === 'manual' ? 'Set by hand'
    : line.priceSource ? `From the ${line.priceSource.replace(/_/g, ' ')} rule`
    : 'Unknown'
  const list = line.listPrice !== null ? ` · list ${formatMoney(line.listPrice)}` : ''
  return `${source}${list}`
}
