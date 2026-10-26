# Journal

Long voice memos, transcribed (German and English), encrypted on the device, locked, with an
optional encrypted cloud copy. A web app without build step, like Snapdoc and Brain Relieve.
Concept and security model: [CONCEPT.md](CONCEPT.md).

Without any set-up the app runs fully on the device: record, play, notes, lock, backup file.
Transcription and the cloud copy need the three steps below.

## 1. Supabase project (3 minutes)

Journal gets its **own** project, not shared with Snapdoc or Brain Relieve.

1. supabase.com → New project, region **EU (Frankfurt)**.
2. SQL Editor → paste and run `supabase-schema.sql` (safe to run again later).
3. Authentication → Providers → Email: on, with magic link (default).
   Authentication → URL Configuration: Site URL and redirect URL = the app's address
   (e.g. `https://smisery-prrivate.github.io/braindump/journal/`).
4. Project Settings → API: copy the **Project URL** and the **publishable key** into `config.js`,
   and put the Project URL into the `connect-src` of the Content-Security-Policy in `index.html`
   (replace `https://YOUR-PROJECT.supabase.co`).
5. After your first sign-in: Authentication → switch off new sign-ups.

## 2. Transcription function (5 minutes)

The function keeps the transcription provider's API key on the server and checks every call
against your sign-in. Needs the Supabase CLI (`npm i -g supabase`).

```sh
cd journal
supabase login
supabase link --project-ref <your project ref>
supabase secrets set OPENAI_API_KEY=sk-...            # or DEEPGRAM_API_KEY=... with STT_PROVIDER=deepgram
supabase secrets set ALLOWED_EMAILS=you@example.com   # only this account may transcribe
supabase secrets set ALLOWED_ORIGIN=https://smisery-prrivate.github.io
supabase functions deploy transcribe
```

Optional secrets: `STT_MODEL` (OpenAI: `gpt-4o-transcribe` default, `whisper-1`,
`gpt-4o-mini-transcribe`; Deepgram: `nova-3`), `MAX_BYTES` (default 25 MB per segment).

Provider notes: OpenAI's `gpt-4o-transcribe` is the default; Deepgram's `nova-3` with
`language=multi` is built for German/English switching inside one sentence. Both are fed
segments of a few minutes, so file-size and length limits never bite. What the provider keeps:
OpenAI retains API audio up to 30 days for abuse monitoring unless zero data retention is granted;
check the current terms of whichever provider you choose.

## 3. Publish

The folder is published with GitHub Pages (microphone, fingerprint and the service worker need
HTTPS). Open it on the phone, "Add to Home Screen", turn the lock on in the menu, record.

## Test

```sh
node test/mock-server.js . 8765 &     # a mock of the cloud endpoints plus a static server
node test/e2e.js                      # headless Chromium with a fake microphone
```

The test records with 3-second segments, checks that nothing readable lands in IndexedDB,
plays back, signs in through a PKCE link, transcribes with a continuity prompt, provokes and
recovers from a provider failure, sets a PIN, relocks and unlocks, kills the page mid-recording
and recovers the parts, writes and restores an encrypted backup into a fresh browser, pulls the
cloud copy on a second device, plays a cloud-only segment and propagates a deletion back.

## Release habit

`VERSION` in `app-core.js`, `CACHE` in `sw.js` and the commit message move together. New files go
into the `ASSETS` list in `sw.js`.
