-- 0005_rls.sql
-- Row-level security on every tenant-scoped table (PRD s7 isolation, s9).
--
-- Two principals reach these tables:
--
--   authenticated  -- a signed-in rep/owner/admin, via the anon key + their JWT.
--                     Every policy below applies. This is the only path a
--                     browser can take.
--   service_role   -- background workers and webhooks. Postgres gives this role
--                     BYPASSRLS, so policies do not constrain it; isolation
--                     there is enforced in the application by the tenant-scoped
--                     client wrapper in src/lib/supabase/tenant.ts, and by the
--                     leak tests in tests/tenant-isolation.test.ts.
--
-- RLS is enabled but not FORCEd: the helper functions in 0001 are SECURITY
-- DEFINER and read public.users, and forcing RLS against the table owner would
-- make that lookup recurse into the policy that calls it.

-- ---------------------------------------------------------------------------
-- tenants / users / invitations
-- ---------------------------------------------------------------------------

alter table public.tenants enable row level security;

create policy tenants_select on public.tenants for select to authenticated
  using (id = app.current_tenant_id() or app.is_platform_admin());

create policy tenants_update on public.tenants for update to authenticated
  using (app.can_admin_tenant(id)) with check (app.can_admin_tenant(id));

-- Tenants are created by hand during onboarding (PRD s12), through the
-- service_role admin path only. No insert or delete policy for authenticated.

alter table public.users enable row level security;

create policy users_select_self on public.users for select to authenticated
  using (id = auth.uid());

create policy users_select_tenant on public.users for select to authenticated
  using (app.can_access_tenant(tenant_id));

-- A user may edit their own display name; role and tenant are admin-only, and
-- the trigger below rejects self-escalation.
create policy users_update_self on public.users for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy users_update_admin on public.users for update to authenticated
  using (app.can_admin_tenant(tenant_id)) with check (app.can_admin_tenant(tenant_id));

create or replace function app.guard_user_privilege_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- service_role and platform admins may reassign freely
  if auth.uid() is null or app.is_platform_admin() then
    return new;
  end if;

  if new.id = auth.uid() and (new.role is distinct from old.role
                              or new.tenant_id is distinct from old.tenant_id) then
    raise exception 'users: cannot change your own role or tenant';
  end if;

  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'users: tenant reassignment is a platform-admin action';
  end if;

  if new.role = 'platform_admin' then
    raise exception 'users: platform_admin is a platform-admin action';
  end if;

  return new;
end;
$$;

create trigger users_guard_privilege before update on public.users
  for each row execute function app.guard_user_privilege_change();

alter table public.invitations enable row level security;

create policy invitations_select on public.invitations for select to authenticated
  using (app.can_admin_tenant(tenant_id));

create policy invitations_insert on public.invitations for insert to authenticated
  with check (app.can_admin_tenant(tenant_id) and role <> 'platform_admin');

create policy invitations_delete on public.invitations for delete to authenticated
  using (app.can_admin_tenant(tenant_id) and accepted_at is null);

-- ---------------------------------------------------------------------------
-- Tenant data: readable by every member, writable per table below.
-- ---------------------------------------------------------------------------

-- Catalogue and pricing are admin-managed: they come from a validated import,
-- not from ad-hoc edits by a rep mid-quote.
do $$
declare t text;
begin
  foreach t in array array[
    'products', 'product_embeddings', 'price_rules', 'customers',
    'customer_identifiers', 'uom_conversions', 'uom_aliases',
    'catalogue_imports', 'catalogue_import_rows'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %1$s_select on public.%1$I for select to authenticated
         using (app.can_access_tenant(tenant_id))', t);
    execute format(
      'create policy %1$s_insert on public.%1$I for insert to authenticated
         with check (app.can_admin_tenant(tenant_id))', t);
    execute format(
      'create policy %1$s_update on public.%1$I for update to authenticated
         using (app.can_admin_tenant(tenant_id))
         with check (app.can_admin_tenant(tenant_id))', t);
    execute format(
      'create policy %1$s_delete on public.%1$I for delete to authenticated
         using (app.can_admin_tenant(tenant_id))', t);
  end loop;
end $$;

-- Quote-desk tables: any member of the tenant may read and write. This is the
-- rep's daily work.
do $$
declare t text;
begin
  foreach t in array array[
    'rfqs', 'rfq_lines', 'quotes', 'quote_lines', 'substitution_map'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %1$s_select on public.%1$I for select to authenticated
         using (app.can_access_tenant(tenant_id))', t);
    execute format(
      'create policy %1$s_insert on public.%1$I for insert to authenticated
         with check (app.can_access_tenant(tenant_id))', t);
    execute format(
      'create policy %1$s_update on public.%1$I for update to authenticated
         using (app.can_access_tenant(tenant_id))
         with check (app.can_access_tenant(tenant_id))', t);
  end loop;
end $$;

-- Deleting a quote line is a normal rep action (6.9); deleting an RFQ or a
-- quote is not, so no delete policy exists for those.
create policy quote_lines_delete on public.quote_lines for delete to authenticated
  using (app.can_access_tenant(tenant_id));

create policy substitution_map_delete on public.substitution_map for delete to authenticated
  using (app.can_admin_tenant(tenant_id));

-- ---------------------------------------------------------------------------
-- Append-only records. Readable by the tenant, insertable where a human action
-- produces one, never updatable or deletable from a browser session.
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['corrections', 'activity_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %1$s_select on public.%1$I for select to authenticated
         using (app.can_access_tenant(tenant_id))', t);
    execute format(
      'create policy %1$s_insert on public.%1$I for insert to authenticated
         with check (app.can_access_tenant(tenant_id))', t);
  end loop;
end $$;

-- Written only by the system; readable by the tenant so an admin can inspect
-- match and classification reasoning (6.2, 6.4).
do $$
declare t text;
begin
  foreach t in array array['classification_log', 'llm_calls', 'inbound_emails', 'email_attachments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %1$s_select on public.%1$I for select to authenticated
         using (app.can_access_tenant(tenant_id))', t);
  end loop;
end $$;

-- An admin correcting a misclassification writes back to classification_log (6.2).
create policy classification_log_update on public.classification_log for update to authenticated
  using (app.can_admin_tenant(tenant_id)) with check (app.can_admin_tenant(tenant_id));

-- ---------------------------------------------------------------------------
-- Operational tables: visible to tenant admins, written only by service_role.
-- mailbox_connections holds encrypted OAuth material and is never exposed to a
-- rep session at all.
-- ---------------------------------------------------------------------------

alter table public.mailbox_connections enable row level security;

create policy mailbox_connections_select on public.mailbox_connections for select to authenticated
  using (app.can_admin_tenant(tenant_id));

alter table public.jobs enable row level security;

create policy jobs_select on public.jobs for select to authenticated
  using (app.can_admin_tenant(tenant_id));

alter table public.notifications enable row level security;

create policy notifications_select on public.notifications for select to authenticated
  using (app.can_access_tenant(tenant_id));

-- ---------------------------------------------------------------------------
-- Storage: original attachments and generated PDFs, tenant-scoped by path.
-- Objects live under <bucket>/<tenant_id>/...
-- ---------------------------------------------------------------------------

-- A path whose first segment is not a uuid belongs to nobody. Casting it
-- directly would raise instead of denying, so the cast is guarded.
create or replace function app.path_tenant_id(object_name text)
returns uuid
language plpgsql
immutable
as $$
begin
  return nullif(split_part(object_name, '/', 1), '')::uuid;
exception when others then
  return null;
end;
$$;

grant execute on function app.path_tenant_id(text) to authenticated, service_role;

insert into storage.buckets (id, name, public)
values ('rfq-attachments', 'rfq-attachments', false),
       ('quote-pdfs', 'quote-pdfs', false),
       ('catalogue-imports', 'catalogue-imports', false),
       ('tenant-branding', 'tenant-branding', false)
on conflict (id) do nothing;

create policy tenant_objects_select on storage.objects for select to authenticated
  using (
    bucket_id in ('rfq-attachments', 'quote-pdfs', 'catalogue-imports', 'tenant-branding')
    and app.can_access_tenant(app.path_tenant_id(name))
  );

create policy tenant_objects_insert on storage.objects for insert to authenticated
  with check (
    bucket_id in ('catalogue-imports', 'tenant-branding')
    and app.can_admin_tenant(app.path_tenant_id(name))
  );

create policy tenant_objects_delete on storage.objects for delete to authenticated
  using (
    bucket_id in ('catalogue-imports', 'tenant-branding')
    and app.can_admin_tenant(app.path_tenant_id(name))
  );
