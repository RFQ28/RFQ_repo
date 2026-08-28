-- 0007_search.sql
-- The three searches the matcher runs against the catalogue (PRD 6.4), plus
-- the correction lookup that outranks all of them (6.8).
--
-- All four are SECURITY DEFINER and take an explicit tenant argument, and all
-- four check that the caller is entitled to that tenant before returning a row.
-- A signed-in rep calling these directly gets their own tenant or an error.

create or replace function public.search_products_text(
  target_tenant uuid,
  query text,
  match_limit int default 10,
  min_similarity real default 0.25
)
returns table (
  product_id uuid,
  sku text,
  description text,
  manufacturer text,
  manufacturer_part_number text,
  upc text,
  similarity real
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not app.can_access_tenant(target_tenant) and auth.uid() is not null then
    raise exception 'not authorised for tenant %', target_tenant;
  end if;

  return query
  select p.id, p.sku, p.description, p.manufacturer, p.manufacturer_part_number, p.upc,
         similarity(p.description, query) as similarity
    from public.products p
   where p.tenant_id = target_tenant
     and p.is_active
     and similarity(p.description, query) >= min_similarity
   order by similarity desc
   limit match_limit;
end;
$$;

grant execute on function public.search_products_text(uuid, text, int, real)
  to authenticated, service_role;

create or replace function public.search_products_vector(
  target_tenant uuid,
  query_embedding vector(1536),
  match_limit int default 10,
  min_similarity real default 0.5
)
returns table (
  product_id uuid,
  sku text,
  description text,
  manufacturer text,
  manufacturer_part_number text,
  upc text,
  similarity real
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not app.can_access_tenant(target_tenant) and auth.uid() is not null then
    raise exception 'not authorised for tenant %', target_tenant;
  end if;

  return query
  select p.id, p.sku, p.description, p.manufacturer, p.manufacturer_part_number, p.upc,
         -- pgvector's <=> is cosine distance; 1 - distance is the similarity
         (1 - (e.embedding <=> query_embedding))::real as similarity
    from public.product_embeddings e
    join public.products p on p.id = e.product_id
   where e.tenant_id = target_tenant
     and p.is_active
     and (1 - (e.embedding <=> query_embedding)) >= min_similarity
   order by e.embedding <=> query_embedding
   limit match_limit;
end;
$$;

grant execute on function public.search_products_vector(uuid, vector, int, real)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- find_corrections (6.8)
--
-- A confirmed correction for the same tenant and the same contractor, against
-- similar raw text, outranks every other match signal. Corrections from other
-- contractors within the tenant are returned too, at lower similarity, because
-- shorthand does travel -- but a contractor's own history always ranks first.
-- ---------------------------------------------------------------------------

create or replace function public.find_corrections(
  target_tenant uuid,
  target_customer uuid,
  raw_normalized text,
  match_limit int default 5,
  min_similarity real default 0.55
)
returns table (
  correction_id uuid,
  product_id uuid,
  sku text,
  description text,
  manufacturer text,
  manufacturer_part_number text,
  upc text,
  similarity real,
  same_customer boolean,
  times_reinforced int
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not app.can_access_tenant(target_tenant) and auth.uid() is not null then
    raise exception 'not authorised for tenant %', target_tenant;
  end if;

  return query
  select c.id, p.id, p.sku, p.description, p.manufacturer, p.manufacturer_part_number, p.upc,
         similarity(c.raw_text_normalized, raw_normalized) as similarity,
         (c.customer_id is not distinct from target_customer) as same_customer,
         c.times_reinforced
    from public.corrections c
    join public.products p on p.id = c.corrected_product_id
   where c.tenant_id = target_tenant
     and c.kind in ('match', 'substitution')
     and c.corrected_product_id is not null
     and p.is_active
     and similarity(c.raw_text_normalized, raw_normalized) >= min_similarity
   order by (c.customer_id is not distinct from target_customer) desc,
            similarity(c.raw_text_normalized, raw_normalized) desc,
            c.times_reinforced desc
   limit match_limit;
end;
$$;

grant execute on function public.find_corrections(uuid, uuid, text, int, real)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- record_correction (6.8)
--
-- Called every time a rep changes a match. Reinforces an existing correction
-- rather than piling up near-duplicates, so `times_reinforced` means something.
-- ---------------------------------------------------------------------------

create or replace function public.record_correction(
  target_tenant uuid,
  target_customer uuid,
  p_raw_text text,
  p_matched_product uuid,
  p_corrected_product uuid,
  p_kind text default 'match',
  p_quote_line uuid default null,
  p_rfq uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  normalized text;
  existing   uuid;
begin
  if not app.can_access_tenant(target_tenant) then
    raise exception 'not authorised for tenant %', target_tenant;
  end if;

  normalized := regexp_replace(lower(trim(p_raw_text)), '\s+', ' ', 'g');

  select id into existing
    from public.corrections
   where tenant_id = target_tenant
     and customer_id is not distinct from target_customer
     and raw_text_normalized = normalized
     and corrected_product_id is not distinct from p_corrected_product
   limit 1;

  if existing is not null then
    update public.corrections
       set times_reinforced = times_reinforced + 1,
           last_applied_at = now()
     where id = existing;
    return existing;
  end if;

  insert into public.corrections (
    tenant_id, customer_id, raw_text, raw_text_normalized,
    matched_product_id, corrected_product_id, kind, quote_line_id, rfq_id, corrected_by
  )
  values (
    target_tenant, target_customer, p_raw_text, normalized,
    p_matched_product, p_corrected_product, p_kind, p_quote_line, p_rfq, auth.uid()
  )
  returning id into existing;

  return existing;
end;
$$;

grant execute on function public.record_correction(uuid, uuid, text, uuid, uuid, text, uuid, uuid)
  to authenticated, service_role;
