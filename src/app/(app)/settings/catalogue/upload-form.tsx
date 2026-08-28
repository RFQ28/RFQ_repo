'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { uploadCatalogueFile, type ActionState } from './actions'
import { Button, Card, Label, Select } from '@/components/ui'

const KINDS = [
  { value: 'products', label: 'Product catalogue', hint: 'SKU, description, list price, UOM, on-hand.' },
  { value: 'price_rules', label: 'Customer price rules', hint: 'Discounts, multipliers, contract and job pricing.' },
  { value: 'customers', label: 'Customers', hint: 'Contractors, with the email domains they write from.' },
  { value: 'substitutions', label: 'Cross-reference', hint: 'Competitor part numbers mapped to your SKUs.' },
]

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Reading the file…' : 'Upload and preview'}
    </Button>
  )
}

export function UploadForm() {
  const [state, action] = useActionState<ActionState, FormData>(uploadCatalogueFile, {})
  const [kind, setKind] = useState('products')

  const selected = KINDS.find((k) => k.value === kind)

  return (
    <Card className="h-fit p-4">
      <form action={action} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="kind">What is this file?</Label>
          <Select id="kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
          {selected && <p className="text-xs text-ink-faint">{selected.hint}</p>}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="file">File</Label>
          <input
            id="file"
            name="file"
            type="file"
            accept=".csv,.xlsx,.xlsm,.tsv,.txt"
            required
            className="w-full text-sm text-ink-soft file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-ink hover:file:bg-canvas"
          />
          <p className="text-xs text-ink-faint">
            .xlsx or .csv. Old .xls files need re-saving first.
          </p>
        </div>

        {kind === 'products' && (
          <label className="flex items-start gap-2 text-sm text-ink-soft">
            <input type="checkbox" name="deactivate_missing" className="mt-0.5" />
            <span>
              This is a complete catalogue — deactivate products that are not in it.
              <span className="mt-0.5 block text-xs text-ink-faint">
                Leave this off for a partial or incremental export.
              </span>
            </span>
          </label>
        )}

        {state.error && (
          <p className="rounded-md border border-flag/25 bg-flag-soft px-3 py-2 text-sm text-flag">
            {state.error}
          </p>
        )}

        <SubmitButton />
      </form>
    </Card>
  )
}
