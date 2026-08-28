'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireTenantAdmin } from '@/lib/auth/session'
import { createImport, discardImport, restageImport, IngestError } from '@/lib/ingest/service'
import { commitImport } from '@/lib/ingest/commit'
import { UnsupportedFileError } from '@/lib/ingest/tabular'
import { FIELD_SPECS } from '@/lib/ingest/mapping'
import type { ImportKind } from '@/lib/db/types'

export type ActionState = { error?: string; message?: string }

const KINDS: ImportKind[] = ['products', 'price_rules', 'customers', 'substitutions']
const MAX_BYTES = 50 * 1024 * 1024

function describe(error: unknown): string {
  if (error instanceof UnsupportedFileError || error instanceof IngestError) return error.message
  console.error('catalogue import failed', error)
  return 'Something went wrong reading that file. The upload was kept — send it to support.'
}

export async function uploadCatalogueFile(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, tenant } = await requireTenantAdmin()

  const kind = String(formData.get('kind') ?? '') as ImportKind
  if (!KINDS.includes(kind)) return { error: 'Pick what kind of file this is.' }

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a file to upload.' }
  if (file.size > MAX_BYTES) {
    return { error: `That file is ${Math.round(file.size / 1024 / 1024)}MB. The limit is 50MB.` }
  }

  let importId: string
  try {
    const result = await createImport({
      tenantId: tenant.id,
      kind,
      file: { name: file.name, buffer: await file.arrayBuffer(), contentType: file.type },
      uploadedBy: user.id,
      deactivateMissing: formData.get('deactivate_missing') === 'on',
    })
    importId = result.importId
  } catch (error) {
    return { error: describe(error) }
  }

  revalidatePath('/settings/catalogue')
  redirect(`/settings/catalogue/${importId}`)
}

export async function remapCatalogueImport(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { tenant } = await requireTenantAdmin()

  const importId = String(formData.get('import_id') ?? '')
  const kind = String(formData.get('kind') ?? '') as ImportKind
  if (!importId || !KINDS.includes(kind)) return { error: 'That import could not be found.' }

  // Only fields this kind actually defines are accepted, so a crafted form
  // cannot introduce a column name the validator has never heard of.
  const mapping: Record<string, string> = {}
  for (const spec of FIELD_SPECS[kind]) {
    const header = formData.get(`map__${spec.field}`)
    if (typeof header === 'string' && header !== '') mapping[spec.field] = header
  }

  try {
    await restageImport({
      tenantId: tenant.id,
      importId,
      mapping,
      deactivateMissing: formData.get('deactivate_missing') === 'on',
    })
  } catch (error) {
    return { error: describe(error) }
  }

  revalidatePath(`/settings/catalogue/${importId}`)
  return { message: 'Mapping updated. The preview below reflects the new columns.' }
}

export async function commitCatalogueImport(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, tenant } = await requireTenantAdmin()
  const importId = String(formData.get('import_id') ?? '')
  if (!importId) return { error: 'That import could not be found.' }

  try {
    const result = await commitImport({ tenantId: tenant.id, importId, userId: user.id })

    const parts = [
      `${result.created} created`,
      `${result.updated} updated`,
      `${result.skipped} unchanged`,
    ]
    if (result.deactivated > 0) parts.push(`${result.deactivated} deactivated`)

    const message = `Committed: ${parts.join(', ')}.`
    revalidatePath('/settings/catalogue')
    revalidatePath(`/settings/catalogue/${importId}`)

    return result.unresolved.length > 0
      ? {
          message,
          error:
            `${result.unresolved.length} row${result.unresolved.length === 1 ? '' : 's'} could not be linked ` +
            `and were left out:\n${result.unresolved.slice(0, 10).join('\n')}`,
        }
      : { message }
  } catch (error) {
    return { error: describe(error) }
  }
}

export async function discardCatalogueImport(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, tenant } = await requireTenantAdmin()
  const importId = String(formData.get('import_id') ?? '')
  if (!importId) return { error: 'That import could not be found.' }

  try {
    await discardImport(tenant.id, importId, user.id)
  } catch (error) {
    return { error: describe(error) }
  }

  revalidatePath('/settings/catalogue')
  redirect('/settings/catalogue')
}
