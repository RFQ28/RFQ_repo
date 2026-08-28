import 'server-only'

import type { JobRow } from '@/lib/db/types'
import { tenantDb } from '@/lib/supabase/tenant'
import { extractFromRows, extractFromText, type ExtractedLine, type ExtractedMetadata } from '@/lib/parse/lines'
import { readTabular, UnsupportedFileError } from '@/lib/ingest/tabular'
import { enqueue } from '../queue'

/**
 * Turn a stored email and its attachments into rfq_lines (PRD 6.3).
 *
 * The order of the original document is preserved, and every line keeps its raw
 * text. A file we cannot read becomes one visible unparsed line naming the file,
 * so a rep sees "we could not read takeoff.pdf" rather than an RFQ that quietly
 * came up short.
 */

const SPREADSHEET = /\.(csv|tsv|txt|xlsx|xlsm|xls)$/i
const IMAGE = /\.(jpe?g|png|heic|webp|gif|tiff?)$/i
const PDF = /\.pdf$/i
const WORD = /\.docx?$/i

export async function parseRfq(job: JobRow): Promise<void> {
  const rfqId = (job.payload as { rfqId?: string })?.rfqId ?? job.rfq_id
  if (!rfqId) throw new Error('parse_rfq job has no rfqId')
  if (!job.tenant_id) throw new Error('parse_rfq job has no tenant')

  const db = tenantDb(job.tenant_id)

  const { data: rfq, error } = await db
    .from('rfqs')
    .select('id, email_id, inbound_emails(body_text, subject)')
    .eq('id', rfqId)
    .single()
  if (error || !rfq) throw new Error(`RFQ ${rfqId} not found`)

  await db.from('rfqs').update({ status: 'parsing' }).eq('id', rfqId)

  const email = rfq.inbound_emails as { body_text: string | null; subject: string | null } | null

  const lines: ExtractedLine[] = []
  const metadata: ExtractedMetadata = {}
  let lineNumber = 0

  const append = (extracted: ExtractedLine[]) => {
    for (const line of extracted) {
      lineNumber += 1
      lines.push({ ...line, lineNumber })
    }
  }

  // The body first: it carries the covering note and often the whole list.
  if (email?.body_text) {
    const fromBody = extractFromText(email.body_text, { sourceDocument: 'Email body' })
    Object.assign(metadata, fromBody.metadata)
    append(fromBody.lines)
  }

  const { data: attachments } = await db
    .from('email_attachments')
    .select('id, filename, storage_path, content_type')
    .eq('email_id', rfq.email_id ?? '')

  for (const attachment of attachments ?? []) {
    if (!SPREADSHEET.test(attachment.filename)) {
      // PDF, image and Word extraction are phase-3 work still to be built.
      // Until they are, the file is surfaced as an unparsed line rather than
      // ignored, because an RFQ short of its attachment is worse than one that
      // says out loud what it could not read.
      lineNumber += 1
      lines.push({
        lineNumber,
        rawText: attachment.filename,
        description: null,
        quantity: null,
        uomAsWritten: null,
        manufacturer: null,
        partNumber: null,
        isParsed: false,
        parseError: describeUnsupported(attachment.filename),
        sourceDocument: attachment.filename,
      })
      continue
    }

    const download = await db.storage.from('rfq-attachments').download(attachment.storage_path)
    if (download.error || !download.data) {
      lineNumber += 1
      lines.push({
        lineNumber,
        rawText: attachment.filename,
        description: null,
        quantity: null,
        uomAsWritten: null,
        manufacturer: null,
        partNumber: null,
        isParsed: false,
        parseError: `Could not open ${attachment.filename}`,
        sourceDocument: attachment.filename,
      })
      continue
    }

    try {
      const sheet = await readTabular({
        name: attachment.filename,
        buffer: await download.data.arrayBuffer(),
      })
      const extracted = extractFromRows(sheet.headers, sheet.rows, { sourceDocument: attachment.filename })
      append(extracted.lines)
    } catch (thrown) {
      lineNumber += 1
      lines.push({
        lineNumber,
        rawText: attachment.filename,
        description: null,
        quantity: null,
        uomAsWritten: null,
        manufacturer: null,
        partNumber: null,
        isParsed: false,
        parseError:
          thrown instanceof UnsupportedFileError
            ? thrown.message
            : `Could not read ${attachment.filename}`,
        sourceDocument: attachment.filename,
      })
    }
  }

  // Re-running replaces the parse rather than appending to it.
  await db.from('rfq_lines').delete().eq('rfq_id', rfqId)

  if (lines.length > 0) {
    const { error: insertError } = await db.from('rfq_lines').insert(
      lines.map((line) => ({
        rfq_id: rfqId,
        line_number: line.lineNumber,
        raw_text: line.rawText,
        description: line.description,
        quantity: line.quantity,
        uom_as_written: line.uomAsWritten,
        manufacturer: line.manufacturer,
        part_number: line.partNumber,
        is_parsed: line.isParsed,
        parse_error: line.parseError,
        source_document: line.sourceDocument ?? null,
      })),
    )
    if (insertError) throw new Error(insertError.message)
  }

  await db
    .from('rfqs')
    .update({
      job_name: metadata.jobName ?? null,
      contractor_name: metadata.contractorName ?? null,
      delivery_address: metadata.deliveryAddress ?? null,
      status: 'matching',
    })
    .eq('id', rfqId)

  await db.log({
    action: 'rfq.parsed',
    entityType: 'rfq',
    entityId: rfqId,
    rfqId,
    detail: {
      lines: lines.length,
      unparsed: lines.filter((l) => !l.isParsed).length,
      attachments: attachments?.length ?? 0,
    },
  })

  await enqueue('match_rfq', {
    tenantId: job.tenant_id,
    rfqId,
    payload: { rfqId },
    dedupeKey: `match_rfq:${rfqId}`,
  })
}

function describeUnsupported(filename: string): string {
  if (PDF.test(filename)) return `${filename} is a PDF — open it and add these lines by hand`
  if (IMAGE.test(filename)) return `${filename} is an image — open it and add these lines by hand`
  if (WORD.test(filename)) return `${filename} is a Word document — open it and add these lines by hand`
  return `${filename} could not be read automatically`
}
