-- 0006_tenant_provisioning.sql
-- Onboarding a distributor by hand (PRD s12): create the tenant, seed the UOM
-- table and the unit aliases contractors actually type, and hand out quote
-- numbers without a race.

-- ---------------------------------------------------------------------------
-- The standard UOM table (6.6). Copied into each tenant at provisioning so a
-- distributor can correct a factor for themselves without affecting anyone else.
-- Factors read as: 1 from_uom = factor to_uom.
-- ---------------------------------------------------------------------------

create or replace function app.seed_uom_defaults(target_tenant uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.uom_conversions (tenant_id, from_uom, to_uom, factor, notes)
  values
    (target_tenant, 'FT',  'FT',   1,        null),
    (target_tenant, 'MFT', 'FT',   1000,     'thousand feet'),
    (target_tenant, 'CFT', 'FT',   100,      'hundred feet'),
    (target_tenant, 'YD',  'FT',   3,        null),
    (target_tenant, 'IN',  'FT',   0.0833333333, null),
    (target_tenant, 'M',   'FT',   3.2808399, null),
    (target_tenant, 'CWT', 'LB',   100,      'hundredweight'),
    (target_tenant, 'TON', 'LB',   2000,     null),
    (target_tenant, 'KG',  'LB',   2.20462262, null),
    (target_tenant, 'DOZ', 'EA',   12,       null),
    (target_tenant, 'GRS', 'EA',   144,      'gross'),
    (target_tenant, 'C',   'EA',   100,      'per hundred')
  on conflict (tenant_id, from_uom, to_uom) do nothing;

  -- Package-shaped units (ROLL, BOX, CTN, COIL, SPOOL, PKG) deliberately have
  -- no global factor: how many feet are on a roll is a property of the product,
  -- not of the unit, and lives in products.units_per_package (6.6).

  insert into public.uom_aliases (tenant_id, alias, uom)
  values
    (target_tenant, 'ea', 'EA'),   (target_tenant, 'each', 'EA'),
    (target_tenant, 'pc', 'EA'),   (target_tenant, 'pcs', 'EA'),
    (target_tenant, 'piece', 'EA'), (target_tenant, 'pieces', 'EA'),
    (target_tenant, 'unit', 'EA'), (target_tenant, 'units', 'EA'),
    (target_tenant, 'ft', 'FT'),   (target_tenant, 'foot', 'FT'),
    (target_tenant, 'feet', 'FT'), (target_tenant, 'lf', 'FT'),
    (target_tenant, 'lin ft', 'FT'), (target_tenant, 'linear feet', 'FT'),
    (target_tenant, 'mft', 'MFT'), (target_tenant, 'm ft', 'MFT'),
    (target_tenant, 'thousand feet', 'MFT'),
    (target_tenant, 'cft', 'CFT'), (target_tenant, 'c ft', 'CFT'),
    (target_tenant, 'in', 'IN'),   (target_tenant, 'inch', 'IN'),
    (target_tenant, 'inches', 'IN'),
    (target_tenant, 'yd', 'YD'),   (target_tenant, 'yard', 'YD'),
    (target_tenant, 'lb', 'LB'),   (target_tenant, 'lbs', 'LB'),
    (target_tenant, 'pound', 'LB'), (target_tenant, 'pounds', 'LB'),
    (target_tenant, 'cwt', 'CWT'),
    (target_tenant, 'roll', 'ROLL'), (target_tenant, 'rolls', 'ROLL'),
    (target_tenant, 'box', 'BOX'),  (target_tenant, 'boxes', 'BOX'),
    (target_tenant, 'bx', 'BOX'),
    (target_tenant, 'carton', 'CTN'), (target_tenant, 'ctn', 'CTN'),
    (target_tenant, 'case', 'CTN'), (target_tenant, 'cs', 'CTN'),
    (target_tenant, 'coil', 'COIL'), (target_tenant, 'coils', 'COIL'),
    (target_tenant, 'spool', 'SPOOL'), (target_tenant, 'spools', 'SPOOL'),
    (target_tenant, 'reel', 'SPOOL'),
    (target_tenant, 'pkg', 'PKG'),  (target_tenant, 'package', 'PKG'),
    (target_tenant, 'pk', 'PKG'),
    (target_tenant, 'doz', 'DOZ'),  (target_tenant, 'dozen', 'DOZ'),
    (target_tenant, 'gal', 'GAL'),  (target_tenant, 'gallon', 'GAL'),
    (target_tenant, 'hr', 'HR'),    (target_tenant, 'hour', 'HR')
  on conflict (tenant_id, alias) do nothing;
$$;

revoke all on function app.seed_uom_defaults(uuid) from public, anon, authenticated;
grant execute on function app.seed_uom_defaults(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- provision_tenant
--
-- Service-role only, and in `public` because it is called over PostgREST rpc().
-- Creates the distributor, seeds their UOM table, and opens
-- an invitation for the first owner so their first Microsoft sign-in lands them
-- in the right place.
-- ---------------------------------------------------------------------------

create or replace function public.provision_tenant(
  p_slug text,
  p_name text,
  p_owner_email text default null,
  p_inbound_address text default null
)
returns public.tenants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t public.tenants;
begin
  insert into public.tenants (slug, name)
  values (lower(p_slug), p_name)
  returning * into t;

  perform app.seed_uom_defaults(t.id);

  if p_inbound_address is not null then
    insert into public.mailbox_connections (tenant_id, method, mailbox_address, inbound_address)
    values (t.id, 'forwarding', p_inbound_address, p_inbound_address);
  end if;

  if p_owner_email is not null then
    insert into public.invitations (tenant_id, email, role)
    values (t.id, lower(p_owner_email), 'owner')
    on conflict do nothing;
  end if;

  insert into public.activity_log (tenant_id, actor_kind, entity_type, entity_id, action, detail)
  values (t.id, 'system', 'tenant', t.id, 'tenant.provisioned',
          jsonb_build_object('slug', t.slug, 'owner_email', p_owner_email));

  return t;
end;
$$;

revoke all on function public.provision_tenant(text, text, text, text) from public, anon, authenticated;
grant execute on function public.provision_tenant(text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- next_quote_number
--
-- Takes a row lock on the tenant so two reps approving at the same moment
-- cannot collide on a number.
-- ---------------------------------------------------------------------------

create or replace function public.next_quote_number(target_tenant uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  prefix text;
  seq    bigint;
begin
  if not app.can_access_tenant(target_tenant) and auth.uid() is not null then
    raise exception 'not authorised for tenant %', target_tenant;
  end if;

  update public.tenants
     set quote_number_seq = quote_number_seq + 1
   where id = target_tenant
  returning quote_number_prefix, quote_number_seq into prefix, seq;

  if seq is null then
    raise exception 'tenant % not found', target_tenant;
  end if;

  return prefix || '-' || seq::text;
end;
$$;

grant execute on function public.next_quote_number(uuid) to authenticated, service_role;
