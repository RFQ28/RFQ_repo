-- 0002_catalogue.sql
-- The tenant's own data: contractors, products, pricing rules, UOM conversions
-- and the substitution cross-reference. All of it arrives by periodic export
-- (PRD s4 -- no live ERP integration in v1).

-- ---------------------------------------------------------------------------
-- customers (contractors)
-- ---------------------------------------------------------------------------

create table if not exists public.customers (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  external_id    text,                 -- their ERP's customer number
  name           text not null,
  contact_name   text,
  contact_email  text,
  phone          text,
  billing_address text,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (tenant_id, external_id)
);

create index if not exists customers_tenant_idx on public.customers (tenant_id);
create index if not exists customers_name_trgm on public.customers using gin (name gin_trgm_ops);

create trigger customers_touch before update on public.customers
  for each row execute function app.touch_updated_at();

-- How we recognise which contractor sent an RFQ (6.5). Domain-level match is
-- the common case; a specific address wins over a domain when both match.
create table if not exists public.customer_identifiers (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  customer_id  uuid not null references public.customers(id) on delete cascade,
  kind         text not null check (kind in ('email_domain', 'email_address')),
  value        text not null,
  -- set when a rep resolved an ambiguous sender by hand; we remember it (6.5)
  confirmed_by uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),

  unique (tenant_id, kind, value)
);

create index if not exists customer_identifiers_lookup
  on public.customer_identifiers (tenant_id, kind, value);

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------

create table if not exists public.products (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,

  sku                 text not null,            -- distributor's own SKU
  manufacturer        text,
  manufacturer_part_number text,
  upc                 text,
  description         text not null,
  category            text,

  list_price          numeric(14,4),
  cost                numeric(14,4),

  -- UOM + packaging (6.6). `uom` is how the catalogue sells it; `units_per_package`
  -- and `base_uom` describe what one sellable package contains.
  uom                 text not null default 'EA',
  base_uom            text,
  units_per_package   numeric(14,4),

  on_hand_qty         numeric(14,4),
  lead_time_days      int,

  is_stocked          boolean not null default true,
  is_active           boolean not null default true,

  -- everything else the export carried, kept so nothing is lost on import
  source_row          jsonb,
  catalogue_import_id uuid,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (tenant_id, sku)
);

create index if not exists products_tenant_idx on public.products (tenant_id);
create index if not exists products_mpn_idx
  on public.products (tenant_id, upper(manufacturer_part_number))
  where manufacturer_part_number is not null;
create index if not exists products_upc_idx
  on public.products (tenant_id, upc) where upc is not null;
create index if not exists products_desc_trgm
  on public.products using gin (description gin_trgm_ops);
create index if not exists products_category_idx on public.products (tenant_id, category);

create trigger products_touch before update on public.products
  for each row execute function app.touch_updated_at();

-- Semantic match vectors (6.4). Kept in their own table so a re-embed never
-- rewrites the catalogue and so the vector index stays narrow.
create table if not exists public.product_embeddings (
  product_id  uuid primary key references public.products(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  model       text not null,
  content     text not null,      -- exactly what was embedded
  embedding   vector(1536) not null,
  created_at  timestamptz not null default now()
);

create index if not exists product_embeddings_tenant_idx
  on public.product_embeddings (tenant_id);
create index if not exists product_embeddings_vec_idx
  on public.product_embeddings using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- price rules (6.5)
--
-- One table, several shapes, resolved by specificity. Highest `precedence`
-- wins; ties break on most-specific scope then latest effective_from.
-- ---------------------------------------------------------------------------

create type public.price_rule_scope as enum (
  'customer',            -- customer-level discount off list
  'customer_category',   -- customer + product category
  'customer_product',    -- customer + specific product
  'contract',            -- manufacturer contract pricing
  'job'                  -- job-specific pricing
);

create type public.price_rule_method as enum (
  'discount_percent_off_list',
  'multiplier_on_list',
  'fixed_price',
  'cost_plus_percent'
);

create table if not exists public.price_rules (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,

  scope          public.price_rule_scope not null,
  method         public.price_rule_method not null,
  value          numeric(14,6) not null,

  customer_id    uuid references public.customers(id) on delete cascade,
  product_id     uuid references public.products(id) on delete cascade,
  category       text,
  manufacturer   text,
  contract_code  text,
  job_name       text,

  precedence     int not null default 0,
  effective_from date,
  effective_to   date,

  external_id    text,
  source_row     jsonb,
  catalogue_import_id uuid,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- each scope must carry the keys it is defined by
  constraint price_rules_scope_keys check (
    case scope
      when 'customer'          then customer_id is not null
      when 'customer_category' then customer_id is not null and category is not null
      when 'customer_product'  then customer_id is not null and product_id is not null
      when 'contract'          then contract_code is not null
      when 'job'               then job_name is not null
    end
  )
);

create index if not exists price_rules_tenant_idx on public.price_rules (tenant_id);
create index if not exists price_rules_customer_idx
  on public.price_rules (tenant_id, customer_id) where customer_id is not null;
create index if not exists price_rules_product_idx
  on public.price_rules (tenant_id, product_id) where product_id is not null;
create index if not exists price_rules_category_idx
  on public.price_rules (tenant_id, customer_id, category) where category is not null;

create trigger price_rules_touch before update on public.price_rules
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- uom_conversions (6.6)
--
-- Tenant-scoped so a distributor can correct a conversion without a deploy.
-- Seeded per tenant from a standard table at onboarding.
-- ---------------------------------------------------------------------------

create table if not exists public.uom_conversions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  from_uom    text not null,
  to_uom      text not null,
  factor      numeric(18,8) not null check (factor > 0),  -- 1 from_uom = factor to_uom
  notes       text,
  created_at  timestamptz not null default now(),

  unique (tenant_id, from_uom, to_uom)
);

-- Free-text units as contractors write them (ft, feet, LF, and so on) mapped
-- onto the canonical unit codes used above.
create table if not exists public.uom_aliases (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  alias       text not null,
  uom         text not null,
  created_at  timestamptz not null default now(),

  unique (tenant_id, alias)
);

-- ---------------------------------------------------------------------------
-- substitution_map (6.7)
-- ---------------------------------------------------------------------------

create table if not exists public.substitution_map (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,

  -- what the contractor asked for; either a catalogue product we do not stock
  -- or a bare manufacturer + part number we have no product row for
  requested_product_id  uuid references public.products(id) on delete cascade,
  requested_manufacturer text,
  requested_part_number  text,

  substitute_product_id uuid not null references public.products(id) on delete cascade,

  relationship          text not null default 'equivalent'
                        check (relationship in ('equivalent', 'upgrade', 'downgrade', 'accessory')),
  notes                 text,
  source                text not null default 'import'
                        check (source in ('import', 'rep', 'inferred')),
  confidence            numeric(4,3),

  created_by            uuid references public.users(id) on delete set null,
  created_at            timestamptz not null default now(),

  constraint substitution_requested_key check (
    requested_product_id is not null
    or (requested_manufacturer is not null and requested_part_number is not null)
  )
);

create index if not exists substitution_tenant_idx on public.substitution_map (tenant_id);
create index if not exists substitution_requested_product_idx
  on public.substitution_map (tenant_id, requested_product_id);
create index if not exists substitution_requested_mpn_idx
  on public.substitution_map (tenant_id, upper(requested_manufacturer), upper(requested_part_number));
