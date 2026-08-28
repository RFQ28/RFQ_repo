/**
 * Database types.
 *
 * Hand-authored to match supabase/migrations. Once a Supabase project exists,
 * `npm run db:types` regenerates this file from the live schema and it becomes
 * the source of truth -- keep the two in step until then.
 */

// Columns nobody hand-writes on an insert. `id` and the timestamps come from
// the database; `tenant_id` is stamped by the tenant-scoped client wrapper
// (lib/supabase/tenant.ts), which is the only thing allowed to decide it.
type Defaulted = 'id' | 'created_at' | 'updated_at' | 'tenant_id'

/**
 * One foreign key, in the shape postgrest-js reads to resolve an embedded
 * select like `.select('id, customers(name)')`. Without these the embed comes
 * back typed `never`, so every join we actually use is declared below.
 */
type Rel<Name extends string, Column extends string, Referenced extends string> = {
  foreignKeyName: Name
  columns: [Column]
  isOneToOne: false
  referencedRelation: Referenced
  referencedColumns: ['id']
}

type Table<Row, Optional extends keyof Row = never, Relationships extends unknown[] = []> = {
  Row: Row
  Insert: Omit<Row, Optional | Extract<Defaulted, keyof Row>> &
    Partial<Pick<Row, Optional | Extract<Defaulted, keyof Row>>>
  Update: Partial<Row>
  Relationships: Relationships
}

// --- enums -----------------------------------------------------------------

export type UserRole = 'pending' | 'rep' | 'owner' | 'tenant_admin' | 'platform_admin'
export type TenantStatus = 'onboarding' | 'active' | 'paused' | 'churned'
export type MailboxMethod = 'graph' | 'forwarding'
export type RfqClassification = 'new_rfq' | 'revision' | 'not_rfq' | 'possible_rfq'
export type RfqStatus =
  | 'received' | 'parsing' | 'matching' | 'draft_ready'
  | 'in_review' | 'quoted' | 'ignored' | 'failed'
export type QuoteStatus =
  | 'draft' | 'in_review' | 'sent' | 'won' | 'lost' | 'no_response' | 'cancelled'
export type ConfidenceBand = 'high' | 'medium' | 'low' | 'no_match'
export type PriceRuleScope =
  | 'customer' | 'customer_category' | 'customer_product' | 'contract' | 'job'
export type PriceRuleMethod =
  | 'discount_percent_off_list' | 'multiplier_on_list' | 'fixed_price' | 'cost_plus_percent'
export type ImportKind = 'products' | 'price_rules' | 'customers' | 'substitutions'
export type ImportStatus =
  | 'uploaded' | 'validating' | 'previewed' | 'committing' | 'committed' | 'failed' | 'discarded'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead'

export type Json = string | number | boolean | null | { [k: string]: Json } | Json[]

// --- rows ------------------------------------------------------------------

export type TenantSettings = {
  confidence: { high: number; medium: number; low: number }
  stale_rfq_hours: number
  notifications: { teams: boolean; email_thread_reply: boolean }
}

export type TenantRow = {
  id: string
  slug: string
  name: string
  status: TenantStatus
  logo_path: string | null
  address: string | null
  phone: string | null
  quote_terms: string | null
  quote_validity_days: number
  quote_number_prefix: string
  quote_number_seq: number
  settings: TenantSettings
  feature_flags: Json
  created_at: string
  updated_at: string
}

export type UserRow = {
  id: string
  tenant_id: string | null
  email: string
  full_name: string | null
  role: UserRole
  is_active: boolean
  last_seen_at: string | null
  created_at: string
  updated_at: string
}

export type InvitationRow = {
  id: string
  tenant_id: string | null
  email: string
  role: UserRole
  invited_by: string | null
  accepted_at: string | null
  accepted_by: string | null
  expires_at: string
  created_at: string
}

export type CustomerRow = {
  id: string
  tenant_id: string
  external_id: string | null
  name: string
  contact_name: string | null
  contact_email: string | null
  phone: string | null
  billing_address: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export type CustomerIdentifierRow = {
  id: string
  tenant_id: string
  customer_id: string
  kind: 'email_domain' | 'email_address'
  value: string
  confirmed_by: string | null
  created_at: string
}

export type ProductRow = {
  id: string
  tenant_id: string
  sku: string
  manufacturer: string | null
  manufacturer_part_number: string | null
  upc: string | null
  description: string
  category: string | null
  list_price: number | null
  cost: number | null
  uom: string
  base_uom: string | null
  units_per_package: number | null
  on_hand_qty: number | null
  lead_time_days: number | null
  is_stocked: boolean
  is_active: boolean
  source_row: Json | null
  catalogue_import_id: string | null
  created_at: string
  updated_at: string
}

export type PriceRuleRow = {
  id: string
  tenant_id: string
  scope: PriceRuleScope
  method: PriceRuleMethod
  value: number
  customer_id: string | null
  product_id: string | null
  category: string | null
  manufacturer: string | null
  contract_code: string | null
  job_name: string | null
  precedence: number
  effective_from: string | null
  effective_to: string | null
  external_id: string | null
  source_row: Json | null
  catalogue_import_id: string | null
  created_at: string
  updated_at: string
}

export type UomConversionRow = {
  id: string
  tenant_id: string
  from_uom: string
  to_uom: string
  factor: number
  notes: string | null
  created_at: string
}

export type UomAliasRow = {
  id: string
  tenant_id: string
  alias: string
  uom: string
  created_at: string
}

export type SubstitutionRow = {
  id: string
  tenant_id: string
  requested_product_id: string | null
  requested_manufacturer: string | null
  requested_part_number: string | null
  substitute_product_id: string
  relationship: 'equivalent' | 'upgrade' | 'downgrade' | 'accessory'
  notes: string | null
  source: 'import' | 'rep' | 'inferred'
  confidence: number | null
  created_by: string | null
  created_at: string
}

export type MailboxConnectionRow = {
  id: string
  tenant_id: string
  method: MailboxMethod
  mailbox_address: string
  ms_tenant_id: string | null
  ms_user_id: string | null
  access_token_enc: string | null
  refresh_token_enc: string | null
  token_expires_at: string | null
  scopes: string[] | null
  subscription_id: string | null
  subscription_expires_at: string | null
  client_state: string | null
  delta_token: string | null
  inbound_address: string | null
  status: 'disconnected' | 'connected' | 'degraded' | 'error'
  last_ok_at: string | null
  last_error: string | null
  last_error_at: string | null
  created_at: string
  updated_at: string
}

export type InboundEmailRow = {
  id: string
  tenant_id: string
  mailbox_connection_id: string | null
  message_id: string
  graph_message_id: string | null
  thread_id: string | null
  in_reply_to: string | null
  from_address: string
  from_name: string | null
  to_addresses: string[] | null
  cc_addresses: string[] | null
  subject: string | null
  body_text: string | null
  body_html: string | null
  received_at: string
  raw_storage_path: string | null
  attachment_hash: string | null
  created_at: string
}

export type EmailAttachmentRow = {
  id: string
  tenant_id: string
  email_id: string
  filename: string
  content_type: string | null
  size_bytes: number | null
  sha256: string
  storage_path: string
  created_at: string
}

export type RfqRow = {
  id: string
  tenant_id: string
  email_id: string | null
  parent_rfq_id: string | null
  revision_number: number
  classification: RfqClassification
  status: RfqStatus
  customer_id: string | null
  customer_confidence: number | null
  job_name: string | null
  contractor_name: string | null
  due_date: string | null
  delivery_address: string | null
  received_at: string
  draft_ready_at: string | null
  first_opened_at: string | null
  claimed_by: string | null
  claimed_at: string | null
  failure_reason: string | null
  created_at: string
  updated_at: string
}

export type ClassificationLogRow = {
  id: string
  tenant_id: string
  email_id: string | null
  rfq_id: string | null
  decision: RfqClassification
  confidence: number | null
  reasoning: string | null
  signals: Json | null
  model: string | null
  corrected_to: RfqClassification | null
  corrected_by: string | null
  corrected_at: string | null
  created_at: string
}

export type RfqLineRow = {
  id: string
  tenant_id: string
  rfq_id: string
  line_number: number
  raw_text: string
  description: string | null
  quantity: number | null
  uom_as_written: string | null
  manufacturer: string | null
  part_number: string | null
  brand: string | null
  notes: string | null
  is_parsed: boolean
  parse_error: string | null
  source_document: string | null
  source_page: number | null
  source_bbox: Json | null
  created_at: string
}

export type QuoteRow = {
  id: string
  tenant_id: string
  rfq_id: string
  customer_id: string | null
  quote_number: string | null
  status: QuoteStatus
  global_margin_percent: number | null
  terms: string | null
  valid_until: string | null
  delivery_notes: string | null
  customer_contact_name: string | null
  customer_contact_email: string | null
  subtotal: number | null
  total: number | null
  pdf_storage_path: string | null
  sent_at: string | null
  sent_by: string | null
  sent_message_id: string | null
  outcome_at: string | null
  outcome_by: string | null
  outcome_notes: string | null
  winning_price: number | null
  created_at: string
  updated_at: string
}

export type MatchAlternative = {
  product_id: string
  sku: string
  description: string
  confidence: number
  method: string
  reasoning?: string
}

export type QuoteLineRow = {
  id: string
  tenant_id: string
  quote_id: string
  rfq_line_id: string | null
  line_number: number
  product_id: string | null
  match_confidence: number | null
  match_band: ConfidenceBand
  match_method: string | null
  match_reasoning: string | null
  alternatives: MatchAlternative[]
  requested_qty: number | null
  requested_uom: string | null
  quoted_qty: number | null
  quoted_uom: string | null
  uom_conversion_applied: boolean
  uom_conversion_note: string | null
  uom_unresolved: boolean
  list_price: number | null
  unit_price: number | null
  price_rule_id: string | null
  price_source: string | null
  price_missing: boolean
  line_margin_percent: number | null
  margin_locked: boolean
  extended_price: number | null
  is_substitution: boolean
  substitution_id: string | null
  substituted_for_text: string | null
  on_hand_qty: number | null
  stock_shortfall: boolean
  lead_time_days: number | null
  is_flagged: boolean
  flag_reasons: string[]
  accepted_by: string | null
  accepted_at: string | null
  was_corrected: boolean
  note: string | null
  is_manual: boolean
  created_at: string
  updated_at: string
}

export type CorrectionRow = {
  id: string
  tenant_id: string
  customer_id: string | null
  raw_text: string
  raw_text_normalized: string
  matched_product_id: string | null
  corrected_product_id: string | null
  kind: 'match' | 'uom' | 'price' | 'substitution' | 'rejection'
  corrected_uom: string | null
  corrected_qty: number | null
  quote_line_id: string | null
  rfq_id: string | null
  corrected_by: string | null
  times_reinforced: number
  last_applied_at: string | null
  created_at: string
}

export type ActivityLogRow = {
  id: string
  tenant_id: string
  actor_id: string | null
  actor_kind: 'user' | 'system'
  entity_type: string
  entity_id: string | null
  rfq_id: string | null
  quote_id: string | null
  action: string
  detail: Json | null
  created_at: string
}

export type LlmCallRow = {
  id: string
  tenant_id: string | null
  purpose: string
  model: string
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  latency_ms: number | null
  request: Json | null
  response: Json | null
  error: string | null
  rfq_id: string | null
  created_at: string
}

export type CatalogueImportDiff = {
  created: number
  updated: number
  unchanged: number
  deactivated: number
  price_changes: number
}

export type CatalogueImportRow = {
  id: string
  tenant_id: string
  kind: ImportKind
  status: ImportStatus
  filename: string
  storage_path: string
  content_type: string | null
  size_bytes: number | null
  sha256: string | null
  column_mapping: Record<string, string> | null
  row_count: number | null
  valid_count: number | null
  error_count: number | null
  warning_count: number | null
  diff_summary: CatalogueImportDiff | null
  deactivate_missing: boolean
  is_scheduled: boolean
  uploaded_by: string | null
  committed_by: string | null
  committed_at: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export type CatalogueImportRowRow = {
  id: string
  tenant_id: string
  import_id: string
  row_number: number
  raw: Record<string, unknown>
  normalized: Record<string, unknown> | null
  is_valid: boolean
  errors: string[]
  warnings: string[]
  diff_action: 'create' | 'update' | 'unchanged' | 'skip' | null
  diff_fields: Record<string, { from: unknown; to: unknown }> | null
  target_id: string | null
  created_at: string
}

export type JobRow = {
  id: string
  tenant_id: string | null
  kind: string
  payload: Json
  dedupe_key: string | null
  status: JobStatus
  priority: number
  attempts: number
  max_attempts: number
  run_after: string
  started_at: string | null
  finished_at: string | null
  locked_by: string | null
  locked_at: string | null
  last_error: string | null
  error_history: Json
  rfq_id: string | null
  created_at: string
  updated_at: string
}

export type NotificationRow = {
  id: string
  tenant_id: string
  kind: string
  channel: 'email_thread' | 'email' | 'teams'
  recipient: string | null
  user_id: string | null
  rfq_id: string | null
  quote_id: string | null
  subject: string | null
  body: string | null
  payload: Json | null
  status: 'pending' | 'sent' | 'failed' | 'suppressed'
  sent_at: string | null
  error: string | null
  dedupe_key: string | null
  created_at: string
}

// --- Database --------------------------------------------------------------

export type Database = {
  public: {
    Tables: {
      tenants: Table<TenantRow, 'slug' | 'status' | 'settings' | 'feature_flags' |
        'quote_validity_days' | 'quote_number_prefix' | 'quote_number_seq' |
        'logo_path' | 'address' | 'phone' | 'quote_terms'>
      users: Table<UserRow, 'tenant_id' | 'full_name' | 'role' | 'is_active' | 'last_seen_at',
        [Rel<'users_tenant_id_fkey', 'tenant_id', 'tenants'>]>
      invitations: Table<InvitationRow, 'tenant_id' | 'invited_by' | 'accepted_at' |
        'accepted_by' | 'expires_at',
        [Rel<'invitations_tenant_id_fkey', 'tenant_id', 'tenants'>]>
      customers: Table<CustomerRow, 'external_id' | 'contact_name' | 'contact_email' |
        'phone' | 'billing_address' | 'is_active',
        [Rel<'customers_tenant_id_fkey', 'tenant_id', 'tenants'>]>
      customer_identifiers: Table<CustomerIdentifierRow, 'confirmed_by'>
      products: Table<ProductRow, 'manufacturer' | 'manufacturer_part_number' | 'upc' |
        'category' | 'list_price' | 'cost' | 'uom' | 'base_uom' | 'units_per_package' |
        'on_hand_qty' | 'lead_time_days' | 'is_stocked' | 'is_active' | 'source_row' |
        'catalogue_import_id',
        [Rel<'products_tenant_id_fkey', 'tenant_id', 'tenants'>]>
      product_embeddings: Table<
        { product_id: string; tenant_id: string; model: string; content: string
          embedding: string; created_at: string },
        'created_at'
      >
      price_rules: Table<PriceRuleRow, 'customer_id' | 'product_id' | 'category' |
        'manufacturer' | 'contract_code' | 'job_name' | 'precedence' | 'effective_from' |
        'effective_to' | 'external_id' | 'source_row' | 'catalogue_import_id',
        [Rel<'price_rules_customer_id_fkey', 'customer_id', 'customers'>,
         Rel<'price_rules_product_id_fkey', 'product_id', 'products'>]>
      uom_conversions: Table<UomConversionRow, 'notes'>
      uom_aliases: Table<UomAliasRow>
      substitution_map: Table<SubstitutionRow, 'requested_product_id' |
        'requested_manufacturer' | 'requested_part_number' | 'relationship' | 'notes' |
        'source' | 'confidence' | 'created_by',
        [Rel<'substitution_map_substitute_product_id_fkey', 'substitute_product_id', 'products'>,
         Rel<'substitution_map_requested_product_id_fkey', 'requested_product_id', 'products'>]>
      mailbox_connections: Table<MailboxConnectionRow, 'ms_tenant_id' | 'ms_user_id' |
        'access_token_enc' | 'refresh_token_enc' | 'token_expires_at' | 'scopes' |
        'subscription_id' | 'subscription_expires_at' | 'client_state' | 'delta_token' |
        'inbound_address' | 'status' | 'last_ok_at' | 'last_error' | 'last_error_at'>
      inbound_emails: Table<InboundEmailRow, 'mailbox_connection_id' | 'graph_message_id' |
        'thread_id' | 'in_reply_to' | 'from_name' | 'to_addresses' | 'cc_addresses' |
        'subject' | 'body_text' | 'body_html' | 'raw_storage_path' | 'attachment_hash'>
      email_attachments: Table<EmailAttachmentRow, 'content_type' | 'size_bytes'>
      rfqs: Table<RfqRow, 'email_id' | 'parent_rfq_id' | 'revision_number' |
        'classification' | 'status' | 'customer_id' | 'customer_confidence' | 'job_name' |
        'contractor_name' | 'due_date' | 'delivery_address' | 'received_at' |
        'draft_ready_at' | 'first_opened_at' | 'claimed_by' | 'claimed_at' | 'failure_reason',
        [Rel<'rfqs_customer_id_fkey', 'customer_id', 'customers'>,
         Rel<'rfqs_email_id_fkey', 'email_id', 'inbound_emails'>]>
      classification_log: Table<ClassificationLogRow, 'email_id' | 'rfq_id' | 'confidence' |
        'reasoning' | 'signals' | 'model' | 'corrected_to' | 'corrected_by' | 'corrected_at'>
      rfq_lines: Table<RfqLineRow, 'description' | 'quantity' | 'uom_as_written' |
        'manufacturer' | 'part_number' | 'brand' | 'notes' | 'is_parsed' | 'parse_error' |
        'source_document' | 'source_page' | 'source_bbox'>
      quotes: Table<QuoteRow, 'customer_id' | 'quote_number' | 'status' |
        'global_margin_percent' | 'terms' | 'valid_until' | 'delivery_notes' |
        'customer_contact_name' | 'customer_contact_email' | 'subtotal' | 'total' |
        'pdf_storage_path' | 'sent_at' | 'sent_by' | 'sent_message_id' | 'outcome_at' |
        'outcome_by' | 'outcome_notes' | 'winning_price',
        [Rel<'quotes_customer_id_fkey', 'customer_id', 'customers'>,
         Rel<'quotes_rfq_id_fkey', 'rfq_id', 'rfqs'>]>
      quote_lines: Table<QuoteLineRow, Exclude<keyof QuoteLineRow,
        'tenant_id' | 'quote_id' | 'line_number'>,
        [Rel<'quote_lines_product_id_fkey', 'product_id', 'products'>,
         Rel<'quote_lines_quote_id_fkey', 'quote_id', 'quotes'>]>
      corrections: Table<CorrectionRow, 'customer_id' | 'matched_product_id' |
        'corrected_product_id' | 'kind' | 'corrected_uom' | 'corrected_qty' |
        'quote_line_id' | 'rfq_id' | 'corrected_by' | 'times_reinforced' | 'last_applied_at'>
      activity_log: Table<ActivityLogRow, 'actor_id' | 'actor_kind' | 'entity_id' |
        'rfq_id' | 'quote_id' | 'detail'>
      llm_calls: Table<LlmCallRow, 'tenant_id' | 'input_tokens' | 'output_tokens' |
        'cost_usd' | 'latency_ms' | 'request' | 'response' | 'error' | 'rfq_id'>
      catalogue_imports: Table<CatalogueImportRow, 'status' | 'content_type' |
        'size_bytes' | 'sha256' | 'column_mapping' | 'row_count' | 'valid_count' |
        'error_count' | 'warning_count' | 'diff_summary' | 'deactivate_missing' |
        'is_scheduled' | 'uploaded_by' | 'committed_by' | 'committed_at' | 'error'>
      catalogue_import_rows: Table<CatalogueImportRowRow, 'normalized' | 'is_valid' |
        'errors' | 'warnings' | 'diff_action' | 'diff_fields' | 'target_id'>
      jobs: Table<JobRow, 'tenant_id' | 'payload' | 'dedupe_key' | 'status' | 'priority' |
        'attempts' | 'max_attempts' | 'run_after' | 'started_at' | 'finished_at' |
        'locked_by' | 'locked_at' | 'last_error' | 'error_history' | 'rfq_id'>
      notifications: Table<NotificationRow, 'recipient' | 'user_id' | 'rfq_id' |
        'quote_id' | 'subject' | 'body' | 'payload' | 'status' | 'sent_at' | 'error' |
        'dedupe_key'>
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: {
      user_role: UserRole
      mailbox_method: MailboxMethod
      rfq_classification: RfqClassification
      rfq_status: RfqStatus
      quote_status: QuoteStatus
      confidence_band: ConfidenceBand
      price_rule_scope: PriceRuleScope
      price_rule_method: PriceRuleMethod
      import_kind: ImportKind
      import_status: ImportStatus
      job_status: JobStatus
    }
    CompositeTypes: Record<string, never>
  }
}

export type TenantScopedTable = Exclude<keyof Database['public']['Tables'], 'tenants' | 'users' | 'invitations'>
