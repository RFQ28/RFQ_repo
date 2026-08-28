-- 0001_foundation.sql
-- Extensions, the `app` helper schema, tenancy primitives, and the RLS
-- helper functions every tenant-scoped policy in 0005 depends on.

create extension if not exists "pgcrypto";
create extension if not exists "vector";
create extension if not exists "pg_trgm";

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------

create table if not exists public.tenants (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  name            text not null,
  status          text not null default 'onboarding'
                  check (status in ('onboarding', 'active', 'paused', 'churned')),

  -- branding, used on the quote PDF (6.11)
  logo_path       text,
  address         text,
  phone           text,
  quote_terms     text,
  quote_validity_days int not null default 30,
  quote_number_prefix text not null default 'Q',
  quote_number_seq    bigint not null default 1000,

  -- tunables that must change without a code change (6.4)
  settings        jsonb not null default jsonb_build_object(
                    'confidence', jsonb_build_object('high', 0.92, 'medium', 0.75, 'low', 0.55),
                    'stale_rfq_hours', 4,
                    'notifications', jsonb_build_object('teams', false, 'email_thread_reply', true)
                  ),
  feature_flags   jsonb not null default '{}'::jsonb,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger tenants_touch before update on public.tenants
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- users
--
-- One row per auth.users row. `tenant_id` is null only for VMSA platform
-- admins, who are the sole role allowed to cross tenant boundaries.
-- ---------------------------------------------------------------------------

-- 'pending' is a user who has authenticated but has not been attached to a
-- tenant yet. It carries no access anywhere. Onboarding is by hand (PRD s12).
create type public.user_role as enum ('pending', 'rep', 'owner', 'tenant_admin', 'platform_admin');

create table if not exists public.users (
  id            uuid primary key references auth.users(id) on delete cascade,
  tenant_id     uuid references public.tenants(id) on delete cascade,
  email         text not null,
  full_name     text,
  role          public.user_role not null default 'pending',
  is_active     boolean not null default true,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Tenant membership and role must agree: only unattached roles have a null
  -- tenant, and every tenant role must name its tenant.
  constraint users_tenant_matches_role check (
    case
      when role in ('platform_admin', 'pending') then tenant_id is null
      else tenant_id is not null
    end
  )
);

create index if not exists users_tenant_idx on public.users (tenant_id);
create unique index if not exists users_email_lower_idx on public.users (lower(email));

create trigger users_touch before update on public.users
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS helpers
--
-- SECURITY DEFINER so they can read public.users without tripping the RLS
-- policy on public.users itself (which would recurse). search_path is pinned.
-- ---------------------------------------------------------------------------

create or replace function app.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.tenant_id from public.users u where u.id = auth.uid();
$$;

create or replace function app.current_role()
returns public.user_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.role from public.users u where u.id = auth.uid();
$$;

create or replace function app.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select u.role = 'platform_admin' and u.is_active from public.users u where u.id = auth.uid()),
    false
  );
$$;

-- True when the caller may read/write rows belonging to `target`.
--
-- A null `target` means a row that belongs to no tenant (a platform-level job
-- or LLM call). Only platform admins reach those. A 'pending' user has a null
-- current_tenant_id, and null = null is null, not true -- so they match nothing.
create or replace function app.can_access_tenant(target uuid)
returns boolean
language sql
stable
as $$
  select app.is_platform_admin()
      or (target is not null and target = app.current_tenant_id());
$$;

-- True for tenant-admin work: catalogue ingestion, pricing, mailbox setup.
create or replace function app.can_admin_tenant(target uuid)
returns boolean
language sql
stable
as $$
  select app.is_platform_admin()
      or (target is not null
          and target = app.current_tenant_id()
          and app.current_role() in ('owner', 'tenant_admin'));
$$;

grant execute on function app.current_tenant_id(), app.current_role(),
  app.is_platform_admin(), app.can_access_tenant(uuid), app.can_admin_tenant(uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- invitations
--
-- There is no self-serve signup (PRD s12). A platform admin invites an address
-- into a tenant; the profile is created with that tenant and role the first
-- time the person actually signs in (Microsoft OAuth or password fallback).
-- ---------------------------------------------------------------------------

create table if not exists public.invitations (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid references public.tenants(id) on delete cascade,
  email        text not null,
  role         public.user_role not null,
  invited_by   uuid references public.users(id) on delete set null,
  accepted_at  timestamptz,
  accepted_by  uuid references public.users(id) on delete set null,
  expires_at   timestamptz not null default now() + interval '30 days',
  created_at   timestamptz not null default now(),

  constraint invitations_role_allowed check (role <> 'pending'),
  constraint invitations_tenant_matches_role check (
    (role = 'platform_admin') = (tenant_id is null)
  )
);

create unique index if not exists invitations_open_email_idx
  on public.invitations (lower(email)) where accepted_at is null;

-- New auth.users rows get a profile. If an open invitation matches the address
-- it is consumed and the profile lands in that tenant; otherwise the profile is
-- 'pending' and can see nothing until an admin attaches it.
create or replace function app.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  invite public.invitations%rowtype;
begin
  select * into invite
  from public.invitations
  where lower(email) = lower(new.email)
    and accepted_at is null
    and expires_at > now()
  order by created_at desc
  limit 1;

  insert into public.users (id, email, full_name, tenant_id, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    invite.tenant_id,
    coalesce(invite.role, 'pending')
  )
  on conflict (id) do nothing;

  if invite.id is not null then
    update public.invitations
       set accepted_at = now(), accepted_by = new.id
     where id = invite.id;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();
