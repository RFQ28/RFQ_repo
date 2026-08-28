-- 0003_rfq_quotes.sql
-- Intake (6.1-6.3), quoting (6.4-6.7, 6.9-6.11), the learning store (6.8),
-- and the audit trails the whole product is judged on (s9 auditability).

-- ---------------------------------------------------------------------------
-- mailbox_connections (6.1)
--
-- Either a Microsoft Graph subscription on a shared mailbox, or a per-tenant
-- inbound address their IT forwards to. Tokens are encrypted at rest by the
-- application before they land here; this table never sees plaintext.
-- ---------------------------------------------------------------------------

create type public.mailbox_method as enum ('graph', 'forwarding');

create table if not exists public.mailbox_connections (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,

  method                public.mailbox_method not null,
  mailbox_address       text not null,          -- quotes@distributor.com

  -- graph
  ms_tenant_id          text,
  ms_user_id            text,
  access_token_enc      text,
  refresh_token_enc     text,
  token_expires_at      timestamptz,
  scopes                text[],
  subscription_id       text,
  subscription_expires_at timestamptz,
  client_state          text,                   -- validates inbound webhooks
  delta_token           text,

  -- forwarding fallback
  inbound_address       text,                   -- tenant-abc@inbound.vmsa.app

  status                text not null default 'disconnected'
                        check (status in ('disconnected', 'connected', 'degraded', 'error')),
  last_ok_at            timestamptz,
  last_error            text,
  last_error_at         timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint mailbox_method_fields check (
    case method
      when 'graph'      then ms_tenant_id is not null
      when 'forwarding' then inbound_address is not null
    end
  )
);

create unique index if not exists mailbox_connections_inbound_idx
  on public.mailbox_connections (lower(inbound_address)) where inbound_address is not null;
create index if not exists mailbox_connections_tenant_idx
  on public.mailbox_connections (tenant_id);
-- background renewal sweeps this (6.1: auto-renew before expiry)
create index if not exists mailbox_connections_sub_expiry_idx
  on public.mailbox_connections (subscription_expires_at)
  where method = 'graph' and status <> 'disconnected';

create trigger mailbox_connections_touch before update on public.mailbox_connections
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- inbound_emails
--
-- The raw original, stored permanently and linked to the RFQ (6.1). Kept
-- separate from `rfqs` because a non-RFQ email is still recorded and a single
-- thread can produce several messages against one RFQ.
-- ---------------------------------------------------------------------------

create table if not exists public.inbound_emails (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  mailbox_connection_id uuid references public.mailbox_connections(id) on delete set null,

  message_id        text not null,          -- RFC822 Message-ID
  graph_message_id  text,
  thread_id         text,                   -- Graph conversationId
  in_reply_to       text,

  from_address      text not null,
  from_name         text,
  to_addresses      text[],
  cc_addresses      text[],
  subject           text,
  body_text         text,
  body_html         text,
  received_at       timestamptz not null,

  raw_storage_path  text,                   -- original .eml in Supabase Storage
  attachment_hash   text,                   -- sha256 over sorted attachment hashes

  created_at        timestamptz not null default now(),

  -- dedup rule 1: one message id per tenant (6.1)
  unique (tenant_id, message_id)
);

create index if not exists inbound_emails_tenant_idx on public.inbound_emails (tenant_id);
create index if not exists inbound_emails_thread_idx on public.inbound_emails (tenant_id, thread_id);
-- dedup rule 2: same sender + same attachment hash within 24h (6.1)
create index if not exists inbound_emails_dedup_idx
  on public.inbound_emails (tenant_id, lower(from_address), attachment_hash, received_at);

create table if not exists public.email_attachments (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  email_id      uuid not null references public.inbound_emails(id) on delete cascade,
  filename      text not null,
  content_type  text,
  size_bytes    bigint,
  sha256        text not null,
  storage_path  text not null,
  created_at    timestamptz not null default now()
);

create index if not exists email_attachments_email_idx on public.email_attachments (email_id);
create index if not exists email_attachments_tenant_idx on public.email_attachments (tenant_id);

-- ---------------------------------------------------------------------------
-- rfqs (6.2, 6.3)
-- ---------------------------------------------------------------------------

create type public.rfq_classification as enum ('new_rfq', 'revision', 'not_rfq', 'possible_rfq');

create type public.rfq_status as enum (
  'received',      -- accepted, not yet parsed
  'parsing',
  'matching',
  'draft_ready',   -- rep can review
  'in_review',     -- a rep has claimed it
  'quoted',        -- quote sent
  'ignored',       -- classified not_rfq
  'failed'         -- exhausted retries; alerts admin, never silently dropped
);

create table if not exists public.rfqs (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,

  email_id          uuid references public.inbound_emails(id) on delete set null,
  parent_rfq_id     uuid references public.rfqs(id) on delete set null,  -- revisions (6.2)
  revision_number   int not null default 0,

  classification    public.rfq_classification not null default 'possible_rfq',
  status            public.rfq_status not null default 'received',

  customer_id       uuid references public.customers(id) on delete set null,
  customer_confidence numeric(4,3),

  -- RFQ-level metadata pulled out of the document (6.3)
  job_name          text,
  contractor_name   text,
  due_date          date,
  delivery_address  text,

  received_at       timestamptz not null default now(),
  draft_ready_at    timestamptz,
  first_opened_at   timestamptz,

  -- multi-user claiming (6.10)
  claimed_by        uuid references public.users(id) on delete set null,
  claimed_at        timestamptz,

  failure_reason    text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists rfqs_tenant_idx on public.rfqs (tenant_id);
create index if not exists rfqs_status_idx on public.rfqs (tenant_id, status);
create index if not exists rfqs_parent_idx on public.rfqs (parent_rfq_id);
-- the owner's one alert: unquoted past a threshold (6.12)
create index if not exists rfqs_stale_idx
  on public.rfqs (tenant_id, received_at)
  where status in ('draft_ready', 'in_review');

create trigger rfqs_touch before update on public.rfqs
  for each row execute function app.touch_updated_at();

-- Every classification decision, with reasoning, for tuning (6.2).
create table if not exists public.classification_log (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  email_id        uuid references public.inbound_emails(id) on delete cascade,
  rfq_id          uuid references public.rfqs(id) on delete set null,

  decision        public.rfq_classification not null,
  confidence      numeric(4,3),
  reasoning       text,
  signals         jsonb,
  model           text,

  -- admin correction of a misclassification (6.2)
  corrected_to    public.rfq_classification,
  corrected_by    uuid references public.users(id) on delete set null,
  corrected_at    timestamptz,

  created_at      timestamptz not null default now()
);

create index if not exists classification_log_tenant_idx on public.classification_log (tenant_id, created_at desc);
create index if not exists classification_log_email_idx on public.classification_log (email_id);

-- ---------------------------------------------------------------------------
-- rfq_lines (6.3)
--
-- Raw text and original order preserved verbatim. A line that could not be
-- parsed is still a row -- nothing is ever silently dropped.
-- ---------------------------------------------------------------------------

create table if not exists public.rfq_lines (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  rfq_id            uuid not null references public.rfqs(id) on delete cascade,

  line_number       int not null,           -- original order, 1-based
  raw_text          text not null,          -- exactly as written

  description       text,
  quantity          numeric(14,4),
  uom_as_written    text,
  manufacturer      text,
  part_number       text,
  brand             text,
  notes             text,

  is_parsed         boolean not null default true,
  parse_error       text,

  -- where this line came from, so the review screen can highlight it (6.9)
  source_document   text,
  source_page       int,
  source_bbox       jsonb,

  created_at        timestamptz not null default now(),

  unique (rfq_id, line_number)
);

create index if not exists rfq_lines_rfq_idx on public.rfq_lines (rfq_id, line_number);
create index if not exists rfq_lines_tenant_idx on public.rfq_lines (tenant_id);

-- ---------------------------------------------------------------------------
-- quotes (6.9-6.11, 6.13)
-- ---------------------------------------------------------------------------

create type public.quote_status as enum ('draft', 'in_review', 'sent', 'won', 'lost', 'no_response', 'cancelled');

create table if not exists public.quotes (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  rfq_id            uuid not null references public.rfqs(id) on delete cascade,
  customer_id       uuid references public.customers(id) on delete set null,

  quote_number      text,
  status            public.quote_status not null default 'draft',

  -- quote-level controls (6.9)
  global_margin_percent numeric(6,3),
  terms             text,
  valid_until       date,
  delivery_notes    text,
  customer_contact_name  text,
  customer_contact_email text,

  subtotal          numeric(14,2),
  total             numeric(14,2),

  pdf_storage_path  text,
  sent_at           timestamptz,
  sent_by           uuid references public.users(id) on delete set null,
  sent_message_id   text,               -- the reply we posted into the thread

  -- won/lost (6.13)
  outcome_at        timestamptz,
  outcome_by        uuid references public.users(id) on delete set null,
  outcome_notes     text,
  winning_price     numeric(14,2),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (tenant_id, quote_number)
);

create index if not exists quotes_tenant_idx on public.quotes (tenant_id, status);
create index if not exists quotes_rfq_idx on public.quotes (rfq_id);

create trigger quotes_touch before update on public.quotes
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- quote_lines
--
-- One row per rfq_line. `match_confidence` drives the review screen split
-- between the flagged section and the collapsed confirmed section (6.9).
-- ---------------------------------------------------------------------------

create type public.confidence_band as enum ('high', 'medium', 'low', 'no_match');

create table if not exists public.quote_lines (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  quote_id          uuid not null references public.quotes(id) on delete cascade,
  rfq_line_id       uuid references public.rfq_lines(id) on delete set null,

  line_number       int not null,
  product_id        uuid references public.products(id) on delete set null,

  -- matching (6.4)
  match_confidence  numeric(4,3),
  match_band        public.confidence_band not null default 'no_match',
  match_method      text,             -- mpn_exact | sku | upc | semantic | correction | manual
  match_reasoning   text,             -- inspectable for every line (6.4)
  alternatives      jsonb not null default '[]'::jsonb,   -- top 3-5 candidates

  -- quantity + UOM (6.6)
  requested_qty     numeric(14,4),
  requested_uom     text,
  quoted_qty        numeric(14,4),
  quoted_uom        text,
  uom_conversion_applied boolean not null default false,
  uom_conversion_note    text,
  uom_unresolved    boolean not null default false,

  -- pricing (6.5)
  list_price        numeric(14,4),
  unit_price        numeric(14,4),
  price_rule_id     uuid references public.price_rules(id) on delete set null,
  price_source      text,             -- rule scope, or 'list_no_rule', or 'manual'
  price_missing     boolean not null default false,
  line_margin_percent numeric(6,3),
  margin_locked     boolean not null default false,   -- global margin skips locked lines
  extended_price    numeric(14,2),

  -- substitution (6.7)
  is_substitution   boolean not null default false,
  substitution_id   uuid references public.substitution_map(id) on delete set null,
  substituted_for_text text,

  -- stock (6.7)
  on_hand_qty       numeric(14,4),
  stock_shortfall   boolean not null default false,
  lead_time_days    int,

  -- review state (6.9)
  is_flagged        boolean not null default false,
  flag_reasons      text[] not null default '{}',
  accepted_by       uuid references public.users(id) on delete set null,
  accepted_at       timestamptz,
  was_corrected     boolean not null default false,
  note              text,
  is_manual         boolean not null default false,   -- rep added this line

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists quote_lines_quote_idx on public.quote_lines (quote_id, line_number);
create index if not exists quote_lines_tenant_idx on public.quote_lines (tenant_id);
create index if not exists quote_lines_flagged_idx on public.quote_lines (quote_id) where is_flagged;

create trigger quote_lines_touch before update on public.quote_lines
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- corrections (6.8) -- the moat
--
-- A confirmed correction for the same tenant + contractor + similar raw text
-- outranks every other match signal on future RFQs.
-- ---------------------------------------------------------------------------

create table if not exists public.corrections (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  customer_id          uuid references public.customers(id) on delete set null,

  raw_text             text not null,          -- as the contractor wrote it
  raw_text_normalized  text not null,          -- lowercased, whitespace-collapsed

  matched_product_id   uuid references public.products(id) on delete set null,
  corrected_product_id uuid references public.products(id) on delete set null,

  kind                 text not null default 'match'
                       check (kind in ('match', 'uom', 'price', 'substitution', 'rejection')),
  corrected_uom        text,
  corrected_qty        numeric(14,4),

  quote_line_id        uuid references public.quote_lines(id) on delete set null,
  rfq_id               uuid references public.rfqs(id) on delete set null,
  corrected_by         uuid references public.users(id) on delete set null,

  times_reinforced     int not null default 1,
  last_applied_at      timestamptz,

  created_at           timestamptz not null default now()
);

create index if not exists corrections_tenant_idx on public.corrections (tenant_id);
-- the lookup the matcher runs first (6.8)
create index if not exists corrections_lookup_idx
  on public.corrections (tenant_id, customer_id, raw_text_normalized);
create index if not exists corrections_norm_trgm
  on public.corrections using gin (raw_text_normalized gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- activity_log (6.10) -- every action on every quote
-- ---------------------------------------------------------------------------

create table if not exists public.activity_log (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  actor_id     uuid references public.users(id) on delete set null,
  actor_kind   text not null default 'user' check (actor_kind in ('user', 'system')),

  entity_type  text not null,    -- rfq | quote | quote_line | catalogue_import | ...
  entity_id    uuid,
  rfq_id       uuid references public.rfqs(id) on delete cascade,
  quote_id     uuid references public.quotes(id) on delete cascade,

  action       text not null,
  detail       jsonb,

  created_at   timestamptz not null default now()
);

create index if not exists activity_log_tenant_idx on public.activity_log (tenant_id, created_at desc);
create index if not exists activity_log_quote_idx on public.activity_log (quote_id, created_at desc);
create index if not exists activity_log_rfq_idx on public.activity_log (rfq_id, created_at desc);

-- ---------------------------------------------------------------------------
-- llm_calls (s8, s9 cost visibility)
-- ---------------------------------------------------------------------------

create table if not exists public.llm_calls (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid references public.tenants(id) on delete cascade,

  purpose        text not null,   -- classify | parse | embed | match
  model          text not null,
  input_tokens   int,
  output_tokens  int,
  cost_usd       numeric(12,6),
  latency_ms     int,

  request        jsonb,
  response       jsonb,
  error          text,

  rfq_id         uuid references public.rfqs(id) on delete set null,
  created_at     timestamptz not null default now()
);

create index if not exists llm_calls_tenant_month_idx on public.llm_calls (tenant_id, created_at desc);
