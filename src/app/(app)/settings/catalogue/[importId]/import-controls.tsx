'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Callout, Card, Select } from '@/components/ui'
import type { FieldSpec } from '@/lib/ingest/mapping'
import type { ImportKind, ImportStatus } from '@/lib/db/types'
import {
  commitCatalogueImport,
  discardCatalogueImport,
  remapCatalogueImport,
  type ActionState,
} from '../actions'

function Pending({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus()
  return <>{pending ? busy : idle}</>
}

export function ImportControls({
  importId,
  kind,
  mapping,
  headers,
  fields,
  deactivateMissing,
  status,
  blocked,
}: {
  importId: string
  kind: ImportKind
  mapping: Record<string, string>
  headers: string[]
  fields: FieldSpec[]
  deactivateMissing: boolean
  status: ImportStatus
  blocked: boolean
}) {
  const [remapState, remap] = useActionState<ActionState, FormData>(remapCatalogueImport, {})
  const [commitState, commit] = useActionState<ActionState, FormData>(commitCatalogueImport, {})
  const [discardState, discard] = useActionState<ActionState, FormData>(discardCatalogueImport, {})

  const editable = status === 'previewed' || status === 'failed'

  return (
    <div className="space-y-4">
      {commitState.message && <Callout tone="ok">{commitState.message}</Callout>}
      {commitState.error && (
        <Callout tone="flag" title="Some rows could not be linked">
          <pre className="mt-1 whitespace-pre-wrap font-sans text-sm">{commitState.error}</pre>
        </Callout>
      )}
      {discardState.error && <Callout tone="flag">{discardState.error}</Callout>}

      <Card className="p-4">
        <form action={remap}>
          <input type="hidden" name="import_id" value={importId} />
          <input type="hidden" name="kind" value={kind} />

          <h2 className="text-sm font-medium text-ink">Column mapping</h2>
          <p className="mt-0.5 mb-3 text-sm text-ink-soft">
            Guessed from the header row. Correct anything wrong here — it is remembered for the next
            export.
          </p>

          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {fields.map((spec) => (
              <div key={spec.field} className="space-y-1">
                <label htmlFor={`map__${spec.field}`} className="block text-sm text-ink">
                  {spec.label}
                  {spec.required && <span className="ml-1 text-flag">*</span>}
                </label>
                <Select
                  id={`map__${spec.field}`}
                  name={`map__${spec.field}`}
                  defaultValue={mapping[spec.field] ?? ''}
                  disabled={!editable}
                >
                  <option value="">— not mapped —</option>
                  {headers.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </Select>
                {spec.hint && <p className="text-xs text-ink-faint">{spec.hint}</p>}
              </div>
            ))}
          </div>

          {kind === 'products' && (
            <label className="mt-4 flex items-start gap-2 text-sm text-ink-soft">
              <input
                type="checkbox"
                name="deactivate_missing"
                defaultChecked={deactivateMissing}
                disabled={!editable}
                className="mt-0.5"
              />
              <span>Deactivate products that are not in this file</span>
            </label>
          )}

          {remapState.error && (
            <p className="mt-3 rounded-md border border-flag/25 bg-flag-soft px-3 py-2 text-sm text-flag">
              {remapState.error}
            </p>
          )}
          {remapState.message && (
            <p className="mt-3 text-sm text-ok">{remapState.message}</p>
          )}

          {editable && (
            <div className="mt-4">
              <Button type="submit" variant="secondary" size="sm">
                <Pending idle="Re-read with this mapping" busy="Re-reading…" />
              </Button>
            </div>
          )}
        </form>
      </Card>

      {editable && (
        <div className="flex items-center gap-3">
          <form action={commit}>
            <input type="hidden" name="import_id" value={importId} />
            <Button type="submit" disabled={blocked || status !== 'previewed'}>
              <Pending idle="Commit to the catalogue" busy="Committing…" />
            </Button>
          </form>

          <form action={discard}>
            <input type="hidden" name="import_id" value={importId} />
            <Button type="submit" variant="ghost" size="sm">
              Discard
            </Button>
          </form>

          {blocked && (
            <p className="text-sm text-flag">Map the required columns before committing.</p>
          )}
        </div>
      )}
    </div>
  )
}
