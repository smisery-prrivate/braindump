-- Brain Relieve v50: repeating thoughts.
-- Run once in Supabase → SQL Editor. Safe to run again.
-- recur:       'd' (daily) or 'w0'..'w6' (weekly, 0 = Sunday); null = no repeat
-- recur_cycle: start of the period the thought last came back for (ms since 1970)
-- Until this runs, the app keeps syncing everything else; the repeat setting then stays on each device.

alter table public.thoughts add column if not exists recur text;
alter table public.thoughts add column if not exists recur_cycle bigint;

-- let the API see the new columns right away
notify pgrst, 'reload schema';
