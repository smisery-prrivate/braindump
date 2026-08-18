-- Brain Relieve v2 sync schema — paste into Supabase SQL Editor and Run.

create table if not exists public.thoughts (
  id text not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  text text not null,
  created bigint not null,
  updated_at bigint not null,
  priority text check (priority in ('light', 'dark')),
  guest bigint,
  guest_used boolean not null default false,
  compass boolean not null default false,
  compass_prev jsonb,
  why text,
  deleted boolean not null default false,
  primary key (user_id, id)
);

alter table public.thoughts enable row level security;

create policy "own rows select" on public.thoughts
  for select using (auth.uid() = user_id);
create policy "own rows insert" on public.thoughts
  for insert with check (auth.uid() = user_id);
create policy "own rows update" on public.thoughts
  for update using (auth.uid() = user_id);
create policy "own rows delete" on public.thoughts
  for delete using (auth.uid() = user_id);

create index if not exists thoughts_user_updated
  on public.thoughts (user_id, updated_at);

-- v34 addendum: the vault (faded thoughts rest as a quiet list)
alter table public.thoughts add column if not exists vault boolean not null default false;
