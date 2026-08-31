'use client'

import { useEffect, useRef, useState } from 'react'
import { Button, Eyebrow, KeyCap } from '@/components/ui'
import { cn, formatQty } from '@/lib/utils'
import type { DecoratedLine, SourceLine } from './model'
import {
  LineFields, Money, SEVERITY_BG, SEVERITY_TEXT, SEVERITY_TINT, type EditHandler,
} from './line-bits'

/**
 * Triage: one flagged line at a time, driven from the keyboard.
 *
 * The list view asks the rep to scan; this asks them to decide. The queue is
 * frozen when the mode opens so that accepting a line does not renumber
 * everything under the cursor, and the two-up comparison answers the question
 * the rep actually has on every line — "is this the right product?" — without
 * making them reconstruct it by eye across two panes.
 */
export function TriagePane({
  queue, sourceByRfqLine, readOnly, cursor, onCursor, onEdit, onAccept, onSwap, onDelete, onExit,
}: {
  queue: DecoratedLine[]
  sourceByRfqLine: Map<string, SourceLine>
  readOnly: boolean
  cursor: number
  onCursor: (index: number) => void
  onEdit: EditHandler
  onAccept: (lineId: string) => void
  onSwap: (lineId: string) => void
  onDelete: (lineId: string) => void
  onExit: () => void
}) {
  const current = queue[cursor]
  const cleared = queue.filter((line) => !line.isFlagged).length
  const qtyRef = useRef<HTMLInputElement>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [lastCursor, setLastCursor] = useState(cursor)

  // Moving to another line withdraws an unanswered delete confirmation, in the
  // same pass — a confirm left armed over a different line is how rows die.
  if (cursor !== lastCursor) {
    setLastCursor(cursor)
    setConfirmDelete(false)
  }

  function step(delta: number) {
    onCursor(Math.min(Math.max(cursor + delta, 0), Math.max(queue.length - 1, 0)))
  }

  function accept() {
    if (readOnly || !current) return
    onAccept(current.id)
    if (cursor < queue.length - 1) step(1)
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const typing = target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (current && !readOnly) onSwap(current.id)
        return
      }
      // Accept still works from inside a field, because the rep's hands are
      // already there after typing a price.
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        if (typing) (target as HTMLInputElement).blur()
        accept()
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (typing) {
        if (event.key === 'Escape') target.blur()
        return
      }

      switch (event.key) {
        case 'Escape':
          event.preventDefault()
          onExit()
          break
        case 'a':
          event.preventDefault()
          accept()
          break
        case 's':
        case 'j':
        case 'ArrowDown':
          event.preventDefault()
          step(1)
          break
        case 'k':
        case 'ArrowUp':
          event.preventDefault()
          step(-1)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, queue, readOnly, current])

  return (
    <div className="flex min-h-[660px]">
      <aside className="flex w-[282px] shrink-0 flex-col border-r border-line bg-sunken">
        <div className="border-b border-line px-[18px] pt-[18px] pb-3.5">
          <div className="mb-2.5 flex items-baseline justify-between">
            <Eyebrow>Queue</Eyebrow>
            <span className="nums font-mono text-xs font-medium text-ink-mid">
              {cleared}/{queue.length} cleared
            </span>
          </div>
          <div className="h-[5px] overflow-hidden rounded-full bg-fill-strong">
            <div
              className="h-full bg-ink transition-[width] duration-[240ms] ease-desk"
              style={{ width: `${queue.length === 0 ? 0 : (cleared / queue.length) * 100}%` }}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {queue.map((line, index) => {
            const selected = index === cursor
            const done = !line.isFlagged
            return (
              <button
                key={line.id}
                type="button"
                onClick={() => onCursor(index)}
                className={cn(
                  'grid w-full grid-cols-[6px_26px_1fr] items-center gap-[9px] rounded-lg p-2.5 text-left transition-colors',
                  selected ? 'bg-fill-strong' : 'hover:bg-fill',
                )}
              >
                <i
                  aria-hidden
                  className={cn(
                    'block size-[6px] rounded-full',
                    done ? 'bg-good' : SEVERITY_BG[line.severity],
                  )}
                />
                <span className="nums font-mono text-2xs font-medium text-ink-ghost">
                  {line.lineNumber}
                </span>
                <span
                  className={cn(
                    'truncate text-sm',
                    selected ? 'font-semibold text-ink' : 'text-ink-mid',
                    done && 'text-ink-faint line-through decoration-ink-pale',
                  )}
                >
                  {line.productDescription ?? line.issues[0] ?? 'Unmatched line'}
                </span>
              </button>
            )
          })}
        </div>

        <div className="flex flex-col gap-[7px] border-t border-line px-[18px] py-3.5 text-[11px] text-ink-dim">
          <div className="flex items-center gap-2">
            <KeyCap>A</KeyCap> accept &amp; next
          </div>
          <div className="flex items-center gap-2">
            <KeyCap>S</KeyCap> skip for now
          </div>
          <div className="flex items-center gap-2">
            <KeyCap>⌘K</KeyCap> swap product
          </div>
          <div className="flex items-center gap-2">
            <KeyCap>Esc</KeyCap> back to the list
          </div>
        </div>
      </aside>

      {current ? (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="px-8 pt-[26px]">
            <div className="mb-4 flex items-center gap-2.5">
              <Eyebrow className="font-medium">
                Line {current.lineNumber} · {cursor + 1} of {queue.length} flagged
              </Eyebrow>
              <div className="flex-1" />
              <ArrowButton label="Previous line" disabled={cursor === 0} onClick={() => step(-1)}>
                ↑
              </ArrowButton>
              <ArrowButton
                label="Next line"
                disabled={cursor >= queue.length - 1}
                onClick={() => step(1)}
              >
                ↓
              </ArrowButton>
            </div>

            <div
              className={cn(
                'mb-[22px] flex items-start gap-2.5 rounded-[10px] border px-4 py-[13px]',
                SEVERITY_TINT[current.severity],
              )}
            >
              <i
                aria-hidden
                className={cn('mt-1 block size-2 shrink-0 rounded-full', SEVERITY_BG[current.severity])}
              />
              <div className="min-w-0">
                <div className={cn('text-base font-semibold', SEVERITY_TEXT[current.severity])}>
                  {current.issues.join(' · ') || 'Nothing flagged on this line'}
                </div>
                {current.explanation && (
                  <div className="mt-1 text-sm text-pretty text-ink-soft">{current.explanation}</div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-[18px]">
              <div className="rounded-[10px] border border-line bg-sunken px-[18px] py-4">
                <Eyebrow className="mb-3">They asked for</Eyebrow>
                <div className="font-mono text-base leading-[1.55] text-ink">
                  {(current.rfqLineId ? sourceByRfqLine.get(current.rfqLineId)?.rawText : null) ??
                    current.substitutedForText ??
                    'Added by hand — no source line.'}
                </div>
                <div className="mt-3 text-xs text-ink-dim">
                  {current.rfqLineId
                    ? [
                        sourceByRfqLine.get(current.rfqLineId)?.sourceDocument ?? 'Email body',
                        `row ${sourceByRfqLine.get(current.rfqLineId)?.lineNumber ?? current.lineNumber}`,
                      ].join(' · ')
                    : 'Manual line'}
                </div>
              </div>

              <div className="rounded-[10px] border border-line px-[18px] py-4">
                <div className="mb-3 flex items-baseline justify-between">
                  <Eyebrow>We matched</Eyebrow>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => onSwap(current.id)}
                      className="text-xs font-medium text-ink-mid underline decoration-dotted underline-offset-2 hover:text-ink"
                    >
                      swap
                    </button>
                  )}
                </div>
                <div
                  className={cn('text-md font-semibold', current.productId ? 'text-ink' : 'text-block')}
                >
                  {current.productDescription ?? 'No product matched'}
                </div>
                {current.sku && (
                  <div className="mt-1.5 font-mono text-xs font-medium text-ink-faint">{current.sku}</div>
                )}
                <div
                  className={cn('nums mt-3 text-xs', current.stockShortfall ? 'text-review' : 'text-ink-dim')}
                >
                  {current.onHandQty === null
                    ? 'Stock unknown'
                    : `${formatQty(current.onHandQty)} on hand${
                        current.leadTimeDays ? ` · ${current.leadTimeDays}d lead` : ''
                      }`}
                </div>
              </div>
            </div>

            <div className="mt-6 flex items-end gap-[26px] border-t border-line pt-[22px]">
              <LineFields
                line={current}
                variant="boxed"
                readOnly={readOnly}
                onEdit={onEdit}
                firstRef={qtyRef}
              />
              <div className="flex-1" />
              <div>
                <Eyebrow className="mb-1.5 font-medium">Line total</Eyebrow>
                <Money line={current} size="focus" />
              </div>
            </div>
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-2.5 border-t border-line bg-sunken px-8 py-[18px]">
            <Button onClick={accept} disabled={readOnly} className="rounded-[9px] px-5 py-3">
              Accept &amp; next
              <kbd className="rounded-[3px] bg-white/20 px-1 py-[3px] font-mono text-[10px] font-medium">
                A
              </kbd>
            </Button>
            <Button
              variant="secondary"
              onClick={() => step(1)}
              className="rounded-[9px] px-4 py-3 font-medium hover:border-line-strong hover:bg-fill hover:text-ink"
            >
              Skip
            </Button>
            <div className="flex-1" />
            {!readOnly &&
              (confirmDelete ? (
                <div className="flex items-center gap-2 text-sm text-ink-soft">
                  Remove line {current.lineNumber} from the quote?
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                    Keep it
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => onDelete(current.id)}>
                    Delete
                  </Button>
                </div>
              ) : (
                <Button variant="danger" onClick={() => setConfirmDelete(true)} className="px-3.5 py-3">
                  Delete line
                </Button>
              ))}
          </div>
        </div>
      ) : (
        <div className="grid flex-1 place-items-center px-8 py-20 text-center">
          <div>
            <p className="text-xl font-semibold text-ink">Queue clear</p>
            <p className="mt-2 text-sm text-ink-faint">
              Every flagged line has been resolved. The quote is ready for a last look.
            </p>
            <Button variant="secondary" className="mt-5" onClick={onExit}>
              Back to the list
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function ArrowButton({
  children, label, disabled, onClick,
}: {
  children: React.ReactNode
  label: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="size-7 rounded-md border border-control bg-surface text-base font-medium text-ink-mid transition-colors hover:bg-fill disabled:opacity-40"
    >
      {children}
    </button>
  )
}
