import 'server-only'

import { createHash } from 'node:crypto'
import type { JobRow, MailboxConnectionRow, RfqClassification } from '@/lib/db/types'
import { adminClient } from '@/lib/supabase/admin'
import { tenantDb, type TenantDb } from '@/lib/supabase/tenant'
import {
  accessTokenFor, getAttachments, getMessage, getMimeContent, headersToRecord,
  type GraphMessage,
} from '@/lib/graph/client'
import { classifyEmail, obviousNonRfq } from '@/lib/llm/classify'
import {
  attachmentSetHash, findDuplicate, findRevisionParent, identifyCustomer,
  type ExistingEmail, type IncomingEmail, type RevisionCandidate,
} from '@/lib/intake/dedup'
import { enqueue } from '../queue'

/**
 * One email, from Graph to a stored RFQ (PRD 6.1, 6.2).
 *
 * The order here is deliberate. The original is stored *before* anything is
 * decided about it, so that whatever the classifier says — and whatever bugs
 * it has this week — the distributor's mail is never lost. Classification is
 * only ever about whether a rep is shown a draft.
 */
export async function ingestEmail(job: JobRow): Promise<void> {
  const payload = job.payload as {
    mailboxConnectionId?: string
    mailbox?: string
    graphMessageId?: string
  }

  if (!job.tenant_id) throw new Error('ingest_email job has no tenant')
  if (!payload.mailboxConnectionId || !payload.graphMessageId) {
    throw new Error('ingest_email job is missing the mailbox connection or message id')
  }

  const db = tenantDb(job.tenant_id)

  const { data: connection, error: connectionError } = await adminClient()
    .from('mailbox_connections')
    .select('*')
    .eq('id', payload.mailboxConnectionId)
    .single()
  if (connectionError || !connection) throw new Error('That mailbox connection no longer exists')

  const mailbox = payload.mailbox ?? connection.mailbox_address
  const token = await accessTokenFor(connection as MailboxConnectionRow)
  const message = await getMessage(token, mailbox, payload.graphMessageId)

  const fromAddress = message.from?.emailAddress?.address?.toLowerCase() ?? ''
  if (!fromAddress) throw new Error(`Message ${payload.graphMessageId} has no sender`)

  // --- attachments, hashed before anything else is decided ------------------

  const attachments = message.hasAttachments ? await getAttachments(token, mailbox, payload.graphMessageId) : []
  const files = attachments
    .filter((attachment) => !attachment.isInline)
    .map((attachment) => {
      const bytes = Buffer.from(attachment.contentBytes!, 'base64')
      return {
        filename: attachment.name,
        contentType: attachment.contentType,
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes,
      }
    })

  const incoming: IncomingEmail = {
    messageId: message.internetMessageId,
    threadId: message.conversationId,
    fromAddress,
    subject: message.subject,
    receivedAt: new Date(message.receivedDateTime),
    attachmentHashes: files.map((file) => file.sha256),
  }

  // --- duplicate? -----------------------------------------------------------

  const { data: recentRows } = await db
    .from('inbound_emails')
    .select('id, message_id, thread_id, from_address, subject, received_at, attachment_hash')
    .gte('received_at', new Date(incoming.receivedAt.getTime() - 48 * 3600_000).toISOString())
    .order('received_at', { ascending: false })
    .limit(200)

  const recent: ExistingEmail[] = (recentRows ?? []).map((row) => ({
    id: row.id,
    messageId: row.message_id,
    threadId: row.thread_id,
    fromAddress: row.from_address,
    subject: row.subject,
    receivedAt: new Date(row.received_at),
    attachmentHash: row.attachment_hash,
  }))

  const duplicate = findDuplicate(incoming, recent)
  if (duplicate.isDuplicate) {
    await db.log({
      action: 'email.duplicate_ignored',
      entityType: 'inbound_email',
      entityId: duplicate.of,
      detail: { reason: duplicate.reason, message_id: incoming.messageId, from: fromAddress },
    })
    return
  }

  // --- store the original, permanently, before deciding anything ------------

  const emailId = crypto.randomUUID()
  const rawPath = db.path('emails', emailId, 'original.eml')

  try {
    const mime = await getMimeContent(token, mailbox, payload.graphMessageId)
    await db.storage.from('rfq-attachments').upload(rawPath, mime, {
      contentType: 'message/rfc822',
      upsert: true,
    })
  } catch (error) {
    // Worth knowing about, but not worth losing the RFQ over — the parsed body
    // and the attachments below are what the pipeline actually reads.
    console.error('could not store the original message', { emailId, error })
  }

  const { error: emailError } = await db.from('inbound_emails').insert({
    id: emailId,
    mailbox_connection_id: connection.id,
    message_id: incoming.messageId,
    graph_message_id: message.id,
    thread_id: message.conversationId,
    from_address: fromAddress,
    from_name: message.from?.emailAddress?.name ?? null,
    to_addresses: (message.toRecipients ?? []).map((r) => r.emailAddress?.address ?? '').filter(Boolean),
    cc_addresses: (message.ccRecipients ?? []).map((r) => r.emailAddress?.address ?? '').filter(Boolean),
    subject: message.subject,
    body_text: bodyText(message),
    body_html: message.body?.contentType === 'html' ? (message.body.content ?? null) : null,
    received_at: incoming.receivedAt.toISOString(),
    raw_storage_path: rawPath,
    attachment_hash: attachmentSetHash(incoming.attachmentHashes),
  })

  if (emailError) {
    // A unique violation here means the message arrived twice at once; the
    // other worker has it.
    if (emailError.code === '23505') return
    throw new Error(`Could not store the email: ${emailError.message}`)
  }

  for (const file of files) {
    const path = db.path('emails', emailId, file.filename)
    const upload = await db.storage.from('rfq-attachments').upload(path, file.bytes, {
      contentType: file.contentType,
      upsert: true,
    })
    if (upload.error) throw new Error(`Could not store ${file.filename}: ${upload.error.message}`)

    await db.from('email_attachments').insert({
      email_id: emailId,
      filename: file.filename,
      content_type: file.contentType,
      size_bytes: file.size,
      sha256: file.sha256,
      storage_path: path,
    })
  }

  // --- is it an RFQ? --------------------------------------------------------

  const headers = headersToRecord(message)
  const shortcut = obviousNonRfq({ from: fromAddress, subject: message.subject, headers })

  let decision: RfqClassification
  let confidence: number
  let reasoning: string
  let signals: Record<string, unknown> | null = null
  let jobName: string | null = null

  if (shortcut) {
    decision = shortcut.decision
    confidence = 0.99
    reasoning = shortcut.reasoning
  } else {
    const threadHasExistingRfq = await threadHasRfq(db, message.conversationId)
    try {
      const classified = await classifyEmail({
        from: fromAddress,
        fromName: message.from?.emailAddress?.name,
        subject: message.subject,
        body: bodyText(message) ?? '',
        attachmentNames: files.map((file) => file.filename),
        threadHasExistingRfq,
        tenantId: job.tenant_id,
      })
      decision = classified.decision
      confidence = classified.confidence
      reasoning = classified.reasoning
      signals = classified.signals
      jobName = classified.job_name
    } catch (error) {
      // A classifier that is down must not silently bin the inbox. Everything
      // goes to the rep as a possible RFQ until it is back.
      decision = 'possible_rfq'
      confidence = 0
      reasoning = `The classifier could not be reached (${error instanceof Error ? error.message : String(error)}), so this is being surfaced for review`
    }
  }

  await db.from('classification_log').insert({
    email_id: emailId,
    decision,
    confidence,
    reasoning,
    signals: (signals ?? null) as never,
    model: shortcut ? 'rule' : 'claude-opus-5',
  })

  if (decision === 'not_rfq') {
    await db.log({
      action: 'email.classified_not_rfq',
      entityType: 'inbound_email',
      entityId: emailId,
      detail: { from: fromAddress, subject: message.subject, reasoning },
    })
    return
  }

  // --- which contractor, and is this a revision? ----------------------------

  const { data: identifierRows } = await db
    .from('customer_identifiers')
    .select('customer_id, kind, value, confirmed_by')

  const customer = identifyCustomer(
    fromAddress,
    (identifierRows ?? []).map((row) => ({
      customerId: row.customer_id,
      kind: row.kind,
      value: row.value,
      confirmedByRep: row.confirmed_by !== null,
    })),
  )

  const revision =
    decision === 'revision' || message.conversationId
      ? findRevisionParent(incoming, await revisionCandidates(db, incoming))
      : { isRevision: false as const }

  const { data: rfq, error: rfqError } = await db
    .from('rfqs')
    .insert({
      email_id: emailId,
      parent_rfq_id: revision.isRevision ? revision.parentRfqId : null,
      revision_number: revision.isRevision ? await nextRevisionNumber(db, revision.parentRfqId) : 0,
      classification: revision.isRevision ? 'revision' : decision === 'revision' ? 'new_rfq' : decision,
      status: 'received',
      customer_id: customer.customerId,
      customer_confidence: customer.confidence,
      job_name: jobName,
      contractor_name: message.from?.emailAddress?.name ?? null,
      received_at: incoming.receivedAt.toISOString(),
    })
    .select('id')
    .single()

  if (rfqError || !rfq) throw new Error(`Could not create the RFQ: ${rfqError?.message}`)

  await db.from('classification_log').update({ rfq_id: rfq.id }).eq('email_id', emailId)

  await db.log({
    action: revision.isRevision ? 'rfq.revision_received' : 'rfq.received',
    entityType: 'rfq',
    entityId: rfq.id,
    rfqId: rfq.id,
    detail: {
      from: fromAddress,
      subject: message.subject,
      attachments: files.length,
      classification: decision,
      classifier_reasoning: reasoning,
      customer: customer.reason,
      customer_ambiguous: customer.ambiguous,
      revision: revision.isRevision ? revision.reason : null,
    },
  })

  await enqueue('parse_rfq', {
    tenantId: job.tenant_id,
    rfqId: rfq.id,
    payload: { rfqId: rfq.id },
    dedupeKey: `parse_rfq:${rfq.id}`,
    priority: 20,
  })
}

// ---------------------------------------------------------------------------

/** Plain text for the classifier and the parser, HTML stripped if that is all there is. */
function bodyText(message: GraphMessage): string | null {
  const content = message.body?.content
  if (!content) return message.bodyPreview ?? null
  if (message.body?.contentType !== 'html') return content

  return content
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function threadHasRfq(db: TenantDb, threadId: string | null): Promise<boolean> {
  if (!threadId) return false
  const { data } = await db
    .from('rfqs')
    .select('id, inbound_emails!inner(thread_id)')
    .eq('inbound_emails.thread_id', threadId)
    .limit(1)
  return (data ?? []).length > 0
}

async function revisionCandidates(db: TenantDb, incoming: IncomingEmail): Promise<RevisionCandidate[]> {
  const { data } = await db
    .from('rfqs')
    .select('id, received_at, inbound_emails!inner(id, thread_id, from_address, subject)')
    .neq('classification', 'not_rfq')
    .gte('received_at', new Date(incoming.receivedAt.getTime() - 30 * 86400_000).toISOString())
    .order('received_at', { ascending: false })
    .limit(100)

  return (data ?? []).map((row) => {
    const email = row.inbound_emails as unknown as {
      id: string
      thread_id: string | null
      from_address: string
      subject: string | null
    }
    return {
      rfqId: row.id,
      emailId: email.id,
      threadId: email.thread_id,
      fromAddress: email.from_address,
      subject: email.subject,
      receivedAt: new Date(row.received_at),
    }
  })
}

async function nextRevisionNumber(db: TenantDb, parentRfqId: string): Promise<number> {
  const { count } = await db
    .from('rfqs')
    .select('id', { count: 'exact', head: true })
    .eq('parent_rfq_id', parentRfqId)
  return (count ?? 0) + 1
}
