-- Journal v1 encrypted cloud copy. Paste into the Supabase SQL Editor of the Journal project and Run.
-- Safe to run twice. Every object carries the jn_ prefix (bucket "jn").
-- The app encrypts on the device. This database only ever holds ciphertext:
--   jn_entries.meta  encrypted title, notes, transcript and segment list, sealed with the change time and delete flag
--   bucket jn        one encrypted audio file per segment, written once, never replaced
--   jn_keys          the cloud key, wrapped with the user's encryption password

create table if not exists public.jn_entries (
  id text not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  meta text not null default '',
  updated_at bigint not null,
  deleted boolean not null default false,
  synced_at bigint not null default 0,
  primary key (user_id, id)
);
create index if not exists jn_entries_user_synced on public.jn_entries (user_id, synced_at);

-- the server stamps every write with a sequence (it never steps back, unlike a clock);
-- devices ask for "everything stamped after my last visit"
create sequence if not exists public.jn_stamp;
create or replace function public.jn_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.synced_at := nextval('public.jn_stamp');
  return new;
end $$;
drop trigger if exists jn_entries_touch on public.jn_entries;
create trigger jn_entries_touch before insert or update on public.jn_entries
  for each row execute function public.jn_touch();

create table if not exists public.jn_keys (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  salt text not null,
  iter integer not null,
  wrapped text not null,
  created_at bigint not null
);

alter table public.jn_entries enable row level security;
alter table public.jn_keys enable row level security;

revoke all on public.jn_entries from anon;
revoke all on public.jn_keys from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.jn_entries to authenticated;
grant select, insert, update on public.jn_keys to authenticated;

drop policy if exists "jn select" on public.jn_entries;
drop policy if exists "jn insert" on public.jn_entries;
drop policy if exists "jn update" on public.jn_entries;
drop policy if exists "jn delete" on public.jn_entries;
create policy "jn select" on public.jn_entries for select to authenticated using (user_id = auth.uid());
create policy "jn insert" on public.jn_entries for insert to authenticated with check (user_id = auth.uid());
create policy "jn update" on public.jn_entries for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "jn delete" on public.jn_entries for delete to authenticated using (user_id = auth.uid());

drop policy if exists "jn key select" on public.jn_keys;
drop policy if exists "jn key insert" on public.jn_keys;
drop policy if exists "jn key update" on public.jn_keys;
create policy "jn key select" on public.jn_keys for select to authenticated using (user_id = auth.uid());
create policy "jn key insert" on public.jn_keys for insert to authenticated with check (user_id = auth.uid());
create policy "jn key update" on public.jn_keys for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- private bucket; files live under <user id>/<segment id>, 50 MB each at most
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('jn', 'jn', false, 52428800, array['application/octet-stream'])
  on conflict (id) do nothing;

drop policy if exists "jn obj select" on storage.objects;
drop policy if exists "jn obj insert" on storage.objects;
drop policy if exists "jn obj update" on storage.objects;
drop policy if exists "jn obj delete" on storage.objects;
create policy "jn obj select" on storage.objects for select to authenticated
  using (bucket_id = 'jn' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "jn obj insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'jn' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "jn obj update" on storage.objects for update to authenticated
  using (bucket_id = 'jn' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "jn obj delete" on storage.objects for delete to authenticated
  using (bucket_id = 'jn' and (storage.foldername(name))[1] = auth.uid()::text);

notify pgrst, 'reload schema';
