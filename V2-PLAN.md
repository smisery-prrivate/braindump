# Brain Relieve v2 — Sync Architecture (branch: v2-sync)

Decision (Pat, 2026-08-01): **Supabase**, EU region, magic-link auth. v1 on `main`
stays live for the incremental LinkedIn launch; v2 grows here.

## Principles
- **Local-first, sync optional.** The app keeps working exactly like v1 without an
  account (localStorage + IndexedDB mirror). Signing in adds sync + cloud backup.
- **Magic link, no passwords.** Email → link → session. Session persists in the PWA.
- **Row-level security.** Every row carries user_id; policies enforce
  `user_id = auth.uid()`. The anon key is public by design.

## Data model (per thought)
Existing fields plus:
- `updated_at` (ms) — stamped centrally in save() by diffing against the last
  snapshot; drives last-write-wins.
- `deleted` (bool) — deletions become tombstones so they propagate across devices;
  views filter them; tombstones purge after 60 days. Undo = un-delete.

## Sync algorithm (v2.0, simple by intent)
1. On open / focus / after each save (debounced ~2s): if signed in,
   `pull` rows with `updated_at > lastSyncedAt`, merge per-item LWW,
   then `push` local items with `updated_at > lastSyncedAt` via upsert.
2. Conflicts: newest `updated_at` wins per item (good enough for one human).
3. Offline: everything queues naturally — next sync reconciles.
4. First sign-in on a device with local data: local items are pushed (adopted by
   the account), remote items merge in.

## Supabase setup (Pat's 3-minute part)
1. supabase.com → Start project → Sign up (GitHub login works).
2. New project: name `brain-relieve`, region **EU (Frankfurt)**, generous free tier.
3. SQL Editor → paste & run `supabase-schema.sql` from this repo.
4. Authentication → Providers → Email: enable "Email" with magic link (default).
5. Project Settings → API: copy **Project URL** and **anon public key** → give to
   Claude. They go into `config.js` (public by design, safe in the repo).

## Rollout
- Build + test on this branch (puppeteer against a test Supabase project).
- When stable: merge to main as v30 ("Sign in to sync" appears in the archive,
  everything else unchanged for anonymous users).
