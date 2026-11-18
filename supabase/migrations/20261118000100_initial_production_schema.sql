-- TrustVendor production schema. Apply only to a new Supabase project.
-- Tenant boundaries are enforced by Postgres RLS, not by frontend filtering.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
revoke create on schema public from public, anon, authenticated;
grant usage on schema public to authenticated;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  created_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'reviewer', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_members_user_id_idx on public.organization_members(user_id);

create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (char_length(email) <= 320),
  role text not null check (role in ('admin', 'reviewer', 'viewer')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'cancelled')),
  invited_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '1 hour'),
  accepted_by uuid references auth.users(id),
  accepted_at timestamptz
);
create index organization_invitations_org_idx on public.organization_invitations(organization_id, created_at desc);
create unique index organization_invitations_pending_email_idx
  on public.organization_invitations(organization_id, lower(email)) where status = 'pending';

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  legal_name text not null check (char_length(trim(legal_name)) between 2 and 160),
  category text not null check (char_length(trim(category)) between 1 and 100),
  country text not null check (char_length(trim(country)) between 2 and 100),
  registration_id text not null check (char_length(trim(registration_id)) between 1 and 100),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, lower(registration_id)),
  unique (organization_id, id)
);
create index suppliers_org_updated_idx on public.suppliers(organization_id, updated_at desc);

create table public.verification_checks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  supplier_id uuid not null,
  check_key text not null check (check_key in ('registration', 'tax', 'bank', 'sanctions', 'address')),
  status text not null default 'pending' check (status in ('pending', 'verified', 'missing', 'flagged')),
  evidence_note text not null default '' check (char_length(evidence_note) <= 1500),
  evidence_source text not null default '' check (char_length(evidence_source) <= 500),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (supplier_id, check_key),
  constraint reviewed_check_requires_note
    check (status = 'pending' or char_length(trim(evidence_note)) > 0),
  constraint positive_or_flagged_check_requires_source
    check (status not in ('verified', 'flagged') or char_length(trim(evidence_source)) > 0),
  constraint verification_check_tenant_fk
    foreign key (organization_id, supplier_id)
    references public.suppliers(organization_id, id) on delete cascade
);
create index verification_checks_org_supplier_idx on public.verification_checks(organization_id, supplier_id);

create table public.audit_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  related_supplier_id uuid not null,
  actor_id uuid references auth.users(id) on delete set null,
  entity_type text not null check (entity_type in ('supplier', 'verification_check')),
  entity_id uuid not null,
  action text not null check (action in ('created', 'updated', 'deleted')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_org_created_idx on public.audit_events(organization_id, created_at desc);
create index audit_events_supplier_created_idx on public.audit_events(organization_id, related_supplier_id, created_at desc);

create or replace function private.is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = p_org and m.user_id = (select auth.uid())
  );
$$;

create or replace function private.has_org_role(p_org uuid, p_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = p_org
      and m.user_id = (select auth.uid())
      and m.role = any (p_roles)
  );
$$;
revoke all on function private.is_org_member(uuid) from public, anon;
revoke all on function private.has_org_role(uuid, text[]) from public, anon;
grant execute on function private.is_org_member(uuid) to authenticated;
grant execute on function private.has_org_role(uuid, text[]) to authenticated;

create or replace function public.list_my_organizations()
returns table (id uuid, name text, role text)
language sql stable security definer set search_path = '' as $$
  select o.id, o.name, m.role
  from public.organizations o
  join public.organization_members m on m.organization_id = o.id
  where m.user_id = (select auth.uid())
  order by o.created_at;
$$;
revoke all on function public.list_my_organizations() from public, anon;
grant execute on function public.list_my_organizations() to authenticated;

create or replace function public.create_organization(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_org_id uuid;
  v_user_id uuid := auth.uid();
  v_name text := trim(coalesce(p_name, ''));
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'Workspace name must be between 2 and 120 characters';
  end if;
  insert into public.organizations(name) values (v_name) returning id into v_org_id;
  insert into public.organization_members(organization_id, user_id, role)
    values (v_org_id, v_user_id, 'owner');
  return v_org_id;
end;
$$;
revoke all on function public.create_organization(text) from public, anon;
grant execute on function public.create_organization(text) to authenticated;

-- Called only by the authenticated invite-member Edge Function using a secret key.
-- Existing accounts are added only after their email has been confirmed.
create or replace function public.add_existing_org_member(p_invitation_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_invitation public.organization_invitations;
  v_user_id uuid;
begin
  select * into v_invitation
    from public.organization_invitations
   where id = p_invitation_id and status = 'pending' and expires_at > now()
   for update;
  if not found then return false; end if;

  select u.id into v_user_id
    from auth.users u
   where lower(u.email) = lower(v_invitation.email)
     and u.email_confirmed_at is not null
   limit 1;
  if v_user_id is null then return false; end if;

  insert into public.organization_members(organization_id, user_id, role)
  values (v_invitation.organization_id, v_user_id, v_invitation.role)
  on conflict (organization_id, user_id) do nothing;
  update public.organization_invitations
     set status = 'accepted', accepted_by = v_user_id, accepted_at = now()
   where id = v_invitation.id;
  return true;
end;
$$;
revoke all on function public.add_existing_org_member(uuid) from public, anon, authenticated;
grant execute on function public.add_existing_org_member(uuid) to service_role;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '' check (char_length(full_name) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at before update on public.profiles
  for each row execute function private.touch_updated_at();

create or replace function private.set_supplier_creator()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.created_by := auth.uid();
  return new;
end;
$$;

create or replace function private.seed_supplier_checks()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.verification_checks (organization_id, supplier_id, check_key)
  values
    (new.organization_id, new.id, 'registration'),
    (new.organization_id, new.id, 'tax'),
    (new.organization_id, new.id, 'bank'),
    (new.organization_id, new.id, 'sanctions'),
    (new.organization_id, new.id, 'address');
  return new;
end;
$$;

create or replace function private.set_check_reviewer()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  if new.status is distinct from old.status
     or new.evidence_note is distinct from old.evidence_note
     or new.evidence_source is distinct from old.evidence_source then
    new.reviewed_by := auth.uid();
    new.reviewed_at := now();
  end if;
  return new;
end;
$$;

create or replace function private.audit_supplier_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_row public.suppliers;
  v_details jsonb := '{}'::jsonb;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  if tg_op = 'UPDATE' then
    v_details := jsonb_strip_nulls(jsonb_build_object(
      'name_changed', old.legal_name is distinct from new.legal_name,
      'category_changed', old.category is distinct from new.category,
      'country_changed', old.country is distinct from new.country,
      'registration_id_changed', old.registration_id is distinct from new.registration_id
    ));
    if v_details = '{"name_changed": false, "category_changed": false, "country_changed": false, "registration_id_changed": false}'::jsonb then
      return new;
    end if;
  end if;
  insert into public.audit_events(organization_id, related_supplier_id, actor_id, entity_type, entity_id, action, details)
  values (v_row.organization_id, v_row.id, auth.uid(), 'supplier', v_row.id,
    case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end,
    v_details);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function private.audit_check_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_row public.verification_checks;
  v_action text := case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end;
  v_details jsonb := '{}'::jsonb;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  if tg_op = 'UPDATE' then
    if old.status is not distinct from new.status
       and old.evidence_note is not distinct from new.evidence_note
       and old.evidence_source is not distinct from new.evidence_source then
      return new;
    end if;
    v_details := jsonb_build_object(
      'supplier_id', new.supplier_id,
      'check_key', new.check_key,
      'previous_status', old.status,
      'new_status', new.status,
      'source_changed', old.evidence_source is distinct from new.evidence_source,
      'note_changed', old.evidence_note is distinct from new.evidence_note
    );
  else
    v_details := jsonb_build_object('supplier_id', v_row.supplier_id, 'check_key', v_row.check_key, 'status', v_row.status);
  end if;
  insert into public.audit_events(organization_id, related_supplier_id, actor_id, entity_type, entity_id, action, details)
  values (v_row.organization_id, v_row.supplier_id, auth.uid(), 'verification_check', v_row.id, v_action, v_details);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function private.claim_pending_invitations()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_invitation record;
begin
  if new.email is null or new.email_confirmed_at is null then return new; end if;
  for v_invitation in
    select i.id, i.organization_id, i.role
    from public.organization_invitations i
    where lower(i.email) = lower(new.email)
      and i.status = 'pending' and i.expires_at > now()
  loop
    insert into public.organization_members(organization_id, user_id, role)
    values (v_invitation.organization_id, new.id, v_invitation.role)
    on conflict (organization_id, user_id) do nothing;
    update public.organization_invitations
       set status = 'accepted', accepted_by = new.id, accepted_at = now()
     where id = v_invitation.id;
  end loop;
  return new;
end;
$$;

create or replace function private.create_user_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, full_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 100))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger suppliers_set_creator before insert on public.suppliers
  for each row execute function private.set_supplier_creator();
create trigger suppliers_touch_updated_at before update on public.suppliers
  for each row execute function private.touch_updated_at();
create trigger suppliers_seed_checks after insert on public.suppliers
  for each row execute function private.seed_supplier_checks();
create trigger suppliers_audit after insert or update or delete on public.suppliers
  for each row execute function private.audit_supplier_change();
create trigger checks_set_reviewer before update on public.verification_checks
  for each row execute function private.set_check_reviewer();
create trigger checks_audit after insert or update or delete on public.verification_checks
  for each row execute function private.audit_check_change();
create trigger auth_user_claims_invites after insert or update of email_confirmed_at on auth.users
  for each row execute function private.claim_pending_invitations();
create trigger auth_user_create_profile after insert on auth.users
  for each row execute function private.create_user_profile();

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.organization_invitations enable row level security;
alter table public.profiles enable row level security;
alter table public.suppliers enable row level security;
alter table public.verification_checks enable row level security;
alter table public.audit_events enable row level security;

create policy organizations_read_member on public.organizations for select to authenticated
  using ((select private.is_org_member(id)));
create policy members_read_org on public.organization_members for select to authenticated
  using ((select private.is_org_member(organization_id)));
create policy invitations_read_admin on public.organization_invitations for select to authenticated
  using ((select private.has_org_role(organization_id, array['owner','admin'])));
create policy profiles_read_self on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_read_workspace_peers on public.profiles for select to authenticated
  using (exists (
    select 1 from public.organization_members mine
    join public.organization_members peer on peer.organization_id = mine.organization_id
    where mine.user_id = (select auth.uid()) and peer.user_id = profiles.id
  ));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy suppliers_read_member on public.suppliers for select to authenticated
  using ((select private.is_org_member(organization_id)));
create policy suppliers_create_reviewer on public.suppliers for insert to authenticated
  with check ((select private.has_org_role(organization_id, array['owner','admin','reviewer'])));
create policy suppliers_update_reviewer on public.suppliers for update to authenticated
  using ((select private.has_org_role(organization_id, array['owner','admin','reviewer'])))
  with check ((select private.has_org_role(organization_id, array['owner','admin','reviewer'])));
create policy suppliers_delete_admin on public.suppliers for delete to authenticated
  using ((select private.has_org_role(organization_id, array['owner','admin'])));

create policy checks_read_member on public.verification_checks for select to authenticated
  using ((select private.is_org_member(organization_id)));
create policy checks_update_reviewer on public.verification_checks for update to authenticated
  using ((select private.has_org_role(organization_id, array['owner','admin','reviewer'])))
  with check ((select private.has_org_role(organization_id, array['owner','admin','reviewer'])));

create policy audit_read_member on public.audit_events for select to authenticated
  using ((select private.is_org_member(organization_id)));
-- audit_events intentionally has no client write, update, or delete policy.

revoke all on public.organizations, public.organization_members,
  public.organization_invitations, public.profiles, public.suppliers, public.verification_checks,
  public.audit_events from anon, authenticated;
grant select on public.organizations, public.organization_members,
  public.organization_invitations, public.profiles, public.suppliers, public.verification_checks,
  public.audit_events to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant insert (organization_id, legal_name, category, country, registration_id)
  on public.suppliers to authenticated;
grant update (legal_name, category, country, registration_id)
  on public.suppliers to authenticated;
grant delete on public.suppliers to authenticated;
grant update (status, evidence_note, evidence_source)
  on public.verification_checks to authenticated;

-- Never enable broad/public table access. Use the authenticated publishable key
-- together with these RLS policies; keep Supabase secret keys server-side only.
