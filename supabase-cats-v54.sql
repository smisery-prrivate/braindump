-- Brain Relieve v54: the category list (names, colours) syncs across your devices.
-- Run once in Supabase → SQL Editor. Safe to run again.
create table if not exists public.br_prefs (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  cats jsonb not null default '[]'::jsonb,
  updated_at bigint not null default 0
);
alter table public.br_prefs enable row level security;
drop policy if exists "own prefs" on public.br_prefs;
create policy "own prefs" on public.br_prefs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update on public.br_prefs to authenticated;
notify pgrst, 'reload schema';
