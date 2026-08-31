'use client'

import { useState } from 'react'
import type { Priority, Severity } from '@/lib/quote/triage'
import { cn, formatMoney, formatQty } from '@/lib/utils'
import type { DecoratedLine } from './model'
import type { LineEditInput } from './actions'

/**
 * The pieces every line is built from, in both the list and the triage pane.
 * All of the colour in the product lives in these four maps.
 */

/** Only blocked and high-priority lines earn an edge; the rest stay quiet. */
export const EDGE: Record<Priority, string> = {
  blocked: 'bg-block',
  high: 'bg-review',
  medium: 'bg-transparent',
  low: 'bg-transparent',
}

export const PILL: Record<Priority, string> = {
  blocked: 'bg-block-tint text-block',
  high: 'bg-review-tint text-review',
  medium: 'bg-fill-strong text-ink-soft',
  low: 'bg-fill text-ink-faint',
}

export const SEVERITY_TEXT: Record<Severity, string> = {
  block: 'text-block',
  warn: 'text-review',
  ok: 'text-ink-faint',
}

export const SEVERITY_BG: Record<Severity, string> = {
  block: 'bg-block',
  warn: 'bg-review',
  ok: 'bg-ink-ghost',
}

export const SEVERITY_TINT: Record<Severity, string> = {
  block: 'border-block-edge bg-block-tint/60',
  warn: 'border-review-edge bg-review-tint/60',
  ok: 'border-line bg-sunken',
}

export function IssueList({ line }: { line: DecoratedLine }) {
  if (line.issues.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-[7px] gap-y-1">
      {line.issues.map((issue) => (
        <span
          key={issue}
          className={cn('flex items-center gap-[5px] text-sm font-medium', SEVERITY_TEXT[line.severity])}
        >
          <i aria-hidden className={cn('block size-[5px] rounded-full', SEVERITY_BG[line.severity])} />
          {issue}
        </span>
      ))}
    </div>
  )
}

/** Extended price over margin. The one column the eye scans vertically. */
export function Money({ line, size = 'row' }: { line: DecoratedLine; size?: 'row' | 'focus' }) {
  const priced = line.extendedPrice !== null
  const thin = line.lineMarginPercent !== null && line.lineMarginPercent < 8
  return (
    <div className="text-right">
      <div
        className={cn(
          'nums font-mono font-semibold',
          size === 'focus' ? 'text-2xl' : 'text-lg',
          priced ? 'text-ink' : 'text-ink-pale',
        )}
      >
        {priced ? formatMoney(line.extendedPrice) : '—'}
      </div>
      {priced && line.lineMarginPercent !== null && (
        <div
          className={cn(
            'nums mt-[3px] font-mono text-[11px]',
            thin ? 'text-review' : 'text-good',
          )}
        >
          {line.lineMarginPercent}% margin
        </div>
      )}
    </div>
  )
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-2xs tracking-[.07em] text-ink-dim uppercase">{children}</span>
  )
}

/**
 * An input that only reports upward when the rep is done with it, so a
 * debounced save never fights the keystrokes.
 *
 * `underline` is the list row (no box, so 26 of them do not read as a form);
 * `boxed` is the triage pane, where there is only ever one line on screen.
 */
export function Field({
  label, value, width, disabled, invalid, variant = 'underline', numeric = true, onCommit, inputRef,
}: {
  label: string
  value: string
  width: number
  disabled?: boolean
  invalid?: boolean
  variant?: 'underline' | 'boxed'
  numeric?: boolean
  onCommit: (value: string) => void
  inputRef?: React.Ref<HTMLInputElement>
}) {
  const [draft, setDraft] = useState(value)
  const [lastValue, setLastValue] = useState(value)

  // A saved edit comes back down as a new `value`; the draft follows it.
  if (value !== lastValue) {
    setLastValue(value)
    setDraft(value)
  }

  return (
    <label
      className={cn(
        'flex',
        variant === 'underline' ? 'items-center gap-[7px]' : 'flex-col gap-[7px]',
      )}
    >
      <FieldLabel>{label}</FieldLabel>
      <input
        ref={inputRef}
        value={draft}
        disabled={disabled}
        placeholder="—"
        inputMode={numeric ? 'decimal' : undefined}
        style={{ width }}
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
          'nums bg-transparent font-mono font-medium text-ink outline-none',
          'placeholder:text-ink-pale disabled:text-ink-faint',
          variant === 'underline'
            ? 'border-b-[1.5px] px-0.5 py-[5px] text-base focus:border-b-ink'
            : 'rounded-lg border px-3 py-[11px] text-[16px] focus:border-ink focus:shadow-[0_0_0_3px_rgba(20,22,28,.08)]',
          invalid
            ? 'border-block'
            : variant === 'underline'
              ? 'border-control'
              : 'border-line-strong',
        )}
      />
    </label>
  )
}

export type EditHandler = (
  lineId: string,
  patch: Partial<DecoratedLine>,
  remote: LineEditInput,
) => void

/**
 * Qty / Unit / Price. The same three fields in both views, so a rep who
 * switches modes mid-quote does not have to re-learn where anything is.
 */
export function LineFields({
  line, variant, readOnly, onEdit, firstRef,
}: {
  line: DecoratedLine
  variant: 'underline' | 'boxed'
  readOnly: boolean
  onEdit: EditHandler
  firstRef?: React.Ref<HTMLInputElement>
}) {
  const wide = variant === 'boxed'
  return (
    <>
      <Field
        label="Qty"
        variant={variant}
        inputRef={firstRef}
        value={line.quotedQty === null ? '' : String(line.quotedQty)}
        width={wide ? 96 : 62}
        disabled={readOnly}
        onCommit={(value) => {
          const qty = value === '' ? null : Number(value)
          if (qty !== null && !Number.isFinite(qty)) return
          onEdit(line.id, { quotedQty: qty }, { quoteLineId: line.id, quotedQty: qty })
        }}
      />
      <Field
        label="Unit"
        variant={variant}
        numeric={false}
        value={line.quotedUom ?? ''}
        width={wide ? 88 : 54}
        disabled={readOnly}
        onCommit={(value) =>
          onEdit(line.id, { quotedUom: value || null }, { quoteLineId: line.id, quotedUom: value || null })
        }
      />
      <Field
        label={wide ? 'Unit price' : 'Price'}
        variant={variant}
        value={line.unitPrice === null ? '' : String(line.unitPrice)}
        width={wide ? 126 : 82}
        disabled={readOnly}
        // A line flagged "no price" with an empty box is the thing that blocks
        // the total, so it says so before the rep tries to accept it.
        invalid={line.priceMissing && line.unitPrice === null}
        onCommit={(value) => {
          const price = value === '' ? null : Number(value)
          if (price !== null && !Number.isFinite(price)) return
          onEdit(line.id, { unitPrice: price }, { quoteLineId: line.id, unitPrice: price })
        }}
      />
    </>
  )
}

/** "asked for 24 ea" and "140 on hand · 10d lead" — context, never an action. */
export function LineContext({ line }: { line: DecoratedLine }) {
  const askedDiffers =
    line.requestedQty !== null &&
    (line.requestedQty !== line.quotedQty || line.requestedUom !== line.quotedUom)

  if (!askedDiffers && line.onHandQty === null) return null

  return (
    <div className="flex items-center gap-3 text-xs text-ink-dim">
      {askedDiffers && (
        <span className="nums">
          asked for {formatQty(line.requestedQty)} {line.requestedUom}
        </span>
      )}
      {line.onHandQty !== null && (
        <span className={cn('nums', line.stockShortfall && 'text-review')}>
          {formatQty(line.onHandQty)} on hand
          {line.leadTimeDays ? ` · ${line.leadTimeDays}d lead` : ''}
        </span>
      )}
    </div>
  )
}
