-- Brain Relieve v47 fix: the code generator must not use gen_random_bytes (lives in the
-- extensions schema on Supabase). Paste into the SQL Editor and Run.
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
grant execute on function public.br_circle_create(text, text) to authenticated;
