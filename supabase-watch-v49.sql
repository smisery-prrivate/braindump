-- Brain Relieve v49: pair a watch with a code — paste into the Supabase SQL Editor and Run.
-- Also switch on Authentication → Sign In / Providers → "Allow anonymous sign-ins".
--
-- The watch signs in anonymously (its own user id) and then types the code the phone shows.
-- From then on it acts for the phone's account: it writes thoughts under the owner's user_id
-- and reads them like the phone does. Everything else (circles, policies) stays as it is.

create table if not exists public.br_devices (
  device_uid uuid primary key,                      -- the watch's anonymous user
  owner_uid uuid not null references auth.users (id) on delete cascade,
  name text,
  linked_at bigint not null
);
create table if not exists public.br_device_codes (
  code text primary key,
  owner_uid uuid not null default auth.uid(),
  created_at bigint not null
);
alter table public.br_devices enable row level security;        -- no policies: only the
alter table public.br_device_codes enable row level security;   -- functions below touch them

-- who am I acting for? the owner when this is a paired device, otherwise myself
create or replace function public.br_owner() returns uuid
language sql security definer stable set search_path = public as $$
  select coalesce((select owner_uid from public.br_devices where device_uid = auth.uid()), auth.uid());
$$;

-- phone: make a pairing code, valid for 10 minutes, one watch per code
create or replace function public.br_device_code() returns text
language plpgsql security definer set search_path = public as $$
declare v_code text; v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from public.br_devices where device_uid = auth.uid()) then raise exception 'a paired device cannot pair others'; end if;
  delete from public.br_device_codes where created_at < v_now - 600000 or owner_uid = auth.uid();
  loop
    v_code := upper(substr(translate(md5(random()::text || clock_timestamp()::text), '0123456789abcdef', 'ABCDEFGHJKMNPQRS'), 1, 6));
    exit when not exists (select 1 from public.br_device_codes where code = v_code);
  end loop;
  insert into public.br_device_codes (code, owner_uid, created_at) values (v_code, auth.uid(), v_now);
  return v_code;
end $$;

-- watch: claim the code; returns {owner, email}
create or replace function public.br_device_link(p_code text, p_name text) returns json
language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_now bigint := (extract(epoch from now()) * 1000)::bigint; v_email text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select owner_uid into v_owner from public.br_device_codes
    where code = upper(trim(p_code)) and created_at > v_now - 600000;
  if v_owner is null then raise exception 'unknown code'; end if;
  delete from public.br_device_codes where code = upper(trim(p_code));
  insert into public.br_devices (device_uid, owner_uid, name, linked_at) values (auth.uid(), v_owner, p_name, v_now)
    on conflict (device_uid) do update set owner_uid = excluded.owner_uid, name = excluded.name, linked_at = excluded.linked_at;
  select email into v_email from auth.users where id = v_owner;
  return json_build_object('owner', v_owner, 'email', v_email);
end $$;

-- phone: list and unpair watches
create or replace function public.br_devices_list() returns json
language sql security definer stable set search_path = public as $$
  select coalesce(json_agg(json_build_object('id', device_uid, 'name', name, 'linked_at', linked_at) order by linked_at desc), '[]'::json)
  from public.br_devices where owner_uid = auth.uid();
$$;
create or replace function public.br_device_unlink(p_device uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.br_devices where device_uid = p_device and owner_uid = auth.uid();
$$;

-- thoughts: a paired device reads and writes the owner's rows
drop policy if exists "own rows insert" on public.thoughts;
create policy "own rows insert" on public.thoughts for insert with check (public.br_owner() = user_id);
drop policy if exists "own rows update" on public.thoughts;
create policy "own rows update" on public.thoughts for update using (public.br_owner() = user_id);
drop policy if exists "own rows delete" on public.thoughts;
create policy "own rows delete" on public.thoughts for delete using (public.br_owner() = user_id);
drop policy if exists "own rows select" on public.thoughts;
drop policy if exists "own or circle rows select" on public.thoughts;
do $$ begin
  if to_regprocedure('public.br_is_member(uuid)') is not null then
    execute 'create policy "own or circle rows select" on public.thoughts for select using (public.br_owner() = user_id or (circle_id is not null and public.br_is_member(circle_id)))';
  else
    execute 'create policy "own or circle rows select" on public.thoughts for select using (public.br_owner() = user_id)';
  end if;
end $$;

grant execute on function public.br_owner() to authenticated;
grant execute on function public.br_device_code() to authenticated;
grant execute on function public.br_device_link(text, text) to authenticated;
grant execute on function public.br_devices_list() to authenticated;
grant execute on function public.br_device_unlink(uuid) to authenticated;
