-- Brain Relieve v47: shared categories ("circles") — paste into the Supabase SQL Editor and Run.
-- A circle is one shared category. Everyone who joined it (by its code) sees the thoughts in it
-- and can tick them off. Every member keeps their own row per thought (own five, own overflow);
-- text, done and the creator's name travel between members.

alter table public.thoughts add column if not exists cat text;
alter table public.thoughts add column if not exists circle_id uuid;
alter table public.thoughts add column if not exists author text;

create table if not exists public.br_circles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  created_by uuid not null default auth.uid(),
  created_at bigint not null
);
create table if not exists public.br_circle_members (
  circle_id uuid not null references public.br_circles (id) on delete cascade,
  user_id uuid not null default auth.uid(),
  name text,
  joined_at bigint not null,
  primary key (circle_id, user_id)
);

-- membership check used by every policy (security definer avoids recursive RLS)
create or replace function public.br_is_member(cid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.br_circle_members where circle_id = cid and user_id = auth.uid());
$$;

alter table public.br_circles enable row level security;
alter table public.br_circle_members enable row level security;
drop policy if exists "br circle select" on public.br_circles;
create policy "br circle select" on public.br_circles for select using (public.br_is_member(id));
drop policy if exists "br member select" on public.br_circle_members;
create policy "br member select" on public.br_circle_members for select using (public.br_is_member(circle_id));
drop policy if exists "br member leave" on public.br_circle_members;
create policy "br member leave" on public.br_circle_members for delete using (user_id = auth.uid());

-- thoughts: own rows as before, plus every row that sits in one of my circles (read only;
-- writes stay on own rows — a member ticks off by marking their own row done)
drop policy if exists "own rows select" on public.thoughts;
drop policy if exists "own or circle rows select" on public.thoughts;
create policy "own or circle rows select" on public.thoughts
  for select using (auth.uid() = user_id or (circle_id is not null and public.br_is_member(circle_id)));
create index if not exists thoughts_circle_updated on public.thoughts (circle_id, updated_at);

-- create a circle and become its first member; returns {id, code, name}
create or replace function public.br_circle_create(p_name text, p_me text) returns json
language plpgsql security definer set search_path = public as $$
declare v_code text; v_id uuid; v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  loop
    v_code := upper(substr(translate(md5(random()::text || clock_timestamp()::text), '0123456789abcdef', 'ABCDEFGHJKMNPQRS'), 1, 6));
    exit when not exists (select 1 from public.br_circles where code = v_code);
  end loop;
  insert into public.br_circles (name, code, created_by, created_at) values (coalesce(nullif(trim(p_name), ''), 'Shared'), v_code, auth.uid(), v_now) returning id into v_id;
  insert into public.br_circle_members (circle_id, user_id, name, joined_at) values (v_id, auth.uid(), p_me, v_now);
  return json_build_object('id', v_id, 'code', v_code, 'name', coalesce(nullif(trim(p_name), ''), 'Shared'));
end $$;

-- join a circle by its code; returns {id, code, name}
create or replace function public.br_circle_join(p_code text, p_me text) returns json
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_name text; v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select id, name into v_id, v_name from public.br_circles where code = upper(trim(p_code));
  if v_id is null then raise exception 'no circle with that code'; end if;
  insert into public.br_circle_members (circle_id, user_id, name, joined_at) values (v_id, auth.uid(), p_me, v_now)
    on conflict (circle_id, user_id) do update set name = excluded.name;
  return json_build_object('id', v_id, 'code', upper(trim(p_code)), 'name', v_name);
end $$;

grant execute on function public.br_is_member(uuid) to authenticated;
grant execute on function public.br_circle_create(text, text) to authenticated;
grant execute on function public.br_circle_join(text, text) to authenticated;
