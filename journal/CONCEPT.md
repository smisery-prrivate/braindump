# Journal

Long voice memos, transcribed, encrypted, locked. Built the Snapdoc way (web app, no build step,
local first, everything sealed on the device, one active window, a lock that restarts the page),
with the same security bar as Snapdoc or higher. Working name "Journal", visible in `index.html`,
`manifest.json` and `VERSION` in `app-core.js`.

## What it does

- **Record.** The big microphone starts a memo; it can run for hours. Every few minutes (5 by
  default, 2 or 10 in the menu) the running recorder is stopped and started again on the same
  microphone stream, so every **segment** is a complete audio file of its own. The moment a
  segment ends it is encrypted and stored, and its transcription can begin while the next segment
  is still recording. Pause, resume, stop, discard. The screen stays on while recording (wake
  lock); the phone's back button never ends a recording, only Stop does.
- **Never lose a recording.** While a segment records, its chunks (every 10 s) are stored
  encrypted as *parts*. A crash, a killed app or a dead battery loses at most the last ten
  seconds: the next start assembles the parts into a segment and closes the entry. A memo with
  nothing in it is dropped.
- **Transcribe.** One *engine* setting (Menu, Transcription) decides how memos and dictated
  notes become text. *Phone* (the default): the phone's own speech recognition listens live
  while a memo records and while a note is dictated; free, no key, no account, but it cannot
  read stored audio afterwards, listens in one language at a time, and that audio goes to
  Google or Apple. *Own key*: Mistral (EU), ElevenLabs, Deepgram or OpenAI, entered once,
  stored encrypted in the vault; each segment, and each dictated clip, goes straight from the
  phone to the service. *Own cloud function*: sign in, the key stays on the server (see below).
  Key and cloud understand German and English mixed in one memo and transcribe stored audio. Segments are transcribed one after
  the other; the last words of the previous segment go along as a hint, so a sentence cut by the
  segment border continues correctly. The transcript is editable; your edits are kept and marked.
  "Transcribe again" starts over. A refused segment is retried after a growing pause (1, 4, 16 …
  minutes, an hour at most) and the entry says why meanwhile. Setting: ask after each memo (the
  default), always, or never (audio only).
- **One text per entry.** An entry is one text, whatever its source: typed, dictated, or
  transcribed from a long recording (each segment's transcript is appended to it once). Two
  buttons on the home screen: the pen writes a new entry, the microphone dictates one (the text
  appears live); holding the microphone starts a long audio recording instead. The entry view
  has a Dictate button that follows the engine: with the phone engine the text appears live
  (Chrome stops after pauses; the app starts it again while dictation is on); with a key or the
  cloud a short clip is recorded and sent, and the text is appended. An entry left empty is not
  kept. "Open in Claude" in the entry menu hands the entry's text to the Claude app or claude.ai
  as the first message of a new chat.
- **Long press** on an entry in the list: a menu with Open, Share as text, Open in Claude, Delete.
- **Journal.** Entries by day, newest first, with time, title, the first lines, length and state.
  Search over titles, notes and transcripts. Each entry has a player over all its segments (seek,
  1× to 2×), the transcript and a notes field. Typed notes without audio exist too (the pen).
  Delete with a 6-second undo. Share an entry as text or its audio files.
- **Lock.** Optional. Fingerprint or screen lock (WebAuthn PRF, the key bound to the
  authenticator), or a password or long PIN (PBKDF2, 600,000 rounds). Locks again after 5 s to
  30 min away. A lock never cuts a recording off: the lock screen covers the app, the microphone
  keeps going, Stop needs the unlock.
- **Cloud copy.** Optional. Sign in by e-mail link, choose an encryption password once, and every
  entry and every segment is kept encrypted in your own Supabase project; a second device signs
  in, enters the password and has the journal. Audio is fetched on demand when played.
- **Backup.** One encrypted file (`.journal`) with everything, wrapped with a backup password,
  readable by Journal on any device. Plus a plain Markdown export of all texts, clearly marked as
  unencrypted, for whatever comes next (structuring, extraction).

## Encryption

Everything is encrypted with AES-256-GCM, all in `vault.js` (WebCrypto, no libraries). The vault
is Snapdoc's, moved into its own namespace (labels `jn|…`, key file `journal-devbox`, database
`journal`), so the two apps share nothing even on one web origin.

- **On the device.** One random *local key* per device encrypts every entry (title, notes,
  transcript, segment list), every audio segment, every part, the sign-in token and the cloud
  bookmark. Every record is sealed with a label naming its place (entry id, segment id, part
  number), so a record cannot be swapped for another unnoticed. Nothing readable is written to
  browser storage, not even while recording.
  - Without a lock the key is wrapped by a second key that scripts cannot export; the wrapped copy
    lies in a small private file (OPFS), which can really be removed, unlike database entries.
  - With the fingerprint / screen lock the key is wrapped by a secret only the phone's
    authenticator releases (WebAuthn PRF); turning the lock on deletes the private file. A
    cancelled confirmation never quietly becomes a weaker lock; browsers that cannot bind the key
    get a *gate* (the lock guards the screen only) and the menu says so.
  - With a password or long PIN the key is derived from it. Digit-only PINs need 12 digits.
  - Turning a lock on where an older copy of the key may linger makes a new key; older records are
    re-encrypted in the background and the old key is dropped (see Snapdoc's concept for the full
    rules; the code is the same).
  - Honest limit: a web page cannot scrub the browser's storage files. Turn the lock on before
    recording anything private.
- **In the cloud.** A second random *cloud key* encrypts each segment and each entry before
  upload. It travels between devices only inside an envelope wrapped with the encryption
  password (PBKDF2, 600,000 rounds); the password never leaves the device. Every entry is sealed
  together with its change time and delete flag; the plain columns must say what the seal says or
  the row is ignored and reported. The server cannot read, alter or forge an entry.
- **Transcription is the one place audio leaves the device, and only by your choice.** With an
  own key a segment goes, over TLS, straight to the chosen service; the key sits sealed in the
  `meta` store (`jn|stt`) and is re-encrypted with every key change like everything else. With
  the cloud function a segment goes to the app's own Supabase Edge Function, which checks the sign-in, optionally
  allows only listed e-mail addresses, hands the audio to the transcription provider and returns
  the text. The function stores nothing and the provider's key never reaches the phone. The
  provider may keep audio for a while under its own terms (OpenAI: up to 30 days for abuse
  monitoring unless zero data retention is granted; Deepgram: see its terms). The returned text is
  stored encrypted like everything else. "Never (audio only)" keeps everything on the device.
- **Nothing else leaves the device.** No cookies, no analytics, no third-party scripts or fonts.
  The Content-Security-Policy in `index.html` allows connections to the app's own origin and the
  one Supabase project, and no inline script. The page refuses to run inside another site's frame.
- **Shared web address.** All of the owner's GitHub Pages apps live on one origin, so a script
  running in a sibling app could reach Journal's storage; with a key-bound lock it cannot read
  the key silently. An address of its own is the full answer (then the passkey is set up again).

## The lock screen

Away longer than the chosen time, in front or in the background: locked again. The lock screen
covers the app at once; when nothing is in flight the page restarts, which clears the key and
every decrypted segment from memory. In flight counts: a recording (never cut off), a segment
being stored, an entry write, a transcription request, a sync pass, a backup. A transcription or
sync under way is aborted and resumed after the unlock; a recording keeps going under the cover
and the restart follows once it was stopped. A PIN typed meanwhile is never thrown away. Under the
lock screen Back closes nothing and no message is drawn. "Reset this app" erases at the very
start of the fresh page.

## One active window

Only one tab or window is active at a time (Web Locks plus an owner mark that every write
checks). A second window takes over when the first is in the background or offers "Use Journal
here" when the first is in use; a window asked to step aside stops and stores a running
recording first, says "busy" meanwhile, and then lets go. A window with a lock that stepped aside
restarts without the key.

## Files

| File | Role |
| --- | --- |
| `index.html` | Layout and styles, no inline script (the CSP forbids it) |
| `vault.js` | All cryptography and the lock methods (Snapdoc's vault, journal namespace) |
| `app-core.js` | Helpers, the write guard, settings, encrypted storage, the entry model, screens, popups |
| `app-journal.js` | Home list, entry view, player, transcript editing, notes, delete with undo, sharing |
| `app-rec.js` | Segmented recorder, parts, wake lock, level meter, recovery of interrupted recordings |
| `app-lock.js` | Lock screen, the menu, re-encryption after a key change |
| `app-sync.js` | Sign-in (PKCE e-mail link), the transcription queue, the encrypted cloud copy |
| `app-backup.js` | Encrypted backup file, restore, Markdown export |
| `app-boot.js` | Becoming the active window, start-up order, updates, housekeeping |
| `sw.js` | Offline: holds one complete release |
| `icon.svg`, `icon-192.png`, `icon-512.png` | The app icon (SVG for the manifest, PNG for the iOS home screen) |
| `supabase-schema.sql` | Tables, policies and the private bucket (run once) |
| `supabase/functions/transcribe/index.ts` | The transcription function (deploy once) |
| `test/e2e.js`, `test/mock-server.js` | End-to-end test in headless Chromium against a mock of the cloud |

The script files share one scope and load in the order above. There is no build step.

## Data model

An entry: `{ id, created, updated_at, title, text, lang, mime, segs, state, dur, deleted,
del_at, tx, merged }` (`transcript` and `tEdited` are folded into `text` by `mergeText` since v5) plus local marks (`cloud`, `srv`, `pushed_at`, `up`, `purged`). A
segment: `{ id, i, dur, mime, size, text, st, lang }` with `st` one of `todo`, `busy`, `done`,
`fail`, `off`. The transcript shown is the edited text when `tEdited`, else the segment texts
joined. Timestamps are milliseconds. Everything is stored in IndexedDB `journal`, stores
`entries` (one sealed record per entry), `segs` (sealed audio + sealed meta), `parts` (chunks of
the segment being recorded), `meta` (key record, session, cursor). Settings that are not
sensitive (lock delay, segment length, transcription mode, language) sit in `localStorage`
under `journal.*`; the lock delay accepts only the offered values.

## Cloud rules

- Local first. The app works fully without an account; transcription and the cloud copy need
  the sign-in, the cloud copy also the encryption password.
- One row per entry (`jn_entries`) and one encrypted object per segment (`jn/<user>/<segment
  id>`), written once and never replaced. An entry is sent only after every segment it names is
  in the cloud. The newest change time wins per entry (one person, a few devices); a device whose
  edit lost sees the other version. Segments never change, so audio is never in conflict.
- Deleted entries become sealed delete markers; their objects are removed afterwards, repeated
  until the cloud confirms. Markers older than 60 days whose objects are gone are dropped.
- The server stamps each write with a sequence (`synced_at`); devices pull everything stamped
  after their last visit. The bookmark lives sealed in the device's `meta` store together with the
  account id, so an account change resets every cloud mark.
- A refused upload is tried again after a growing pause; "Copy now" tries at once. A pass stops
  when the window is no longer active, the lock closes or the account changes.
- The sign-in link is requested with a PKCE challenge and carries a one-time code that only this
  browser can exchange; a link is accepted only if this browser asked for one within the hour and
  nobody is signed in. The token is stored encrypted and refreshed by the app.

## Transcription rules

- Newest memo first, one segment at a time, the previous segment's last 200 characters as the
  prompt. Language: detect (German and English), or fixed German or English.
- The function (`supabase/functions/transcribe`) accepts one segment of up to 25 MB (configurable),
  checks the user with the project's auth service, honours `ALLOWED_EMAILS`, and calls Mistral
  (`voxtral-mini-transcribe-3`, the default), OpenAI (`gpt-4o-transcribe`) or Deepgram
  (`nova-3`, `language=multi` for code-switching) depending on `STT_PROVIDER`. Segments
  stay well under every provider's size and length limits because they are a few minutes each.
- A transcription cut off by a restart goes back to "todo". The queue runs while recording, after
  the unlock, when the app returns to the front, when the connection comes back and once a minute.

## Honest limits

- iOS Safari suspends the microphone when the app goes to the background or the screen locks;
  keep the app in front on iPhones. Android Chrome keeps recording while the screen is on (the
  wake lock keeps it on).
- On iOS the recorder writes `audio/mp4`; the recovery of an interrupted recording assembles its
  chunks and relies on the browser to play what it produced, which works for WebM/Opus
  (Android, desktop) and is best effort for MP4.
- Storage: about 20 MB per hour of audio. Browsers grant web apps a large share of the disk, but
  not forever if the app is never installed; the menu warns when the browser makes no promise.
- Two devices editing the same entry's text at the same time: the later change wins.

## Set-up (once, by the owner)

See `README.md`.

## History

- v5 (2026-10-27): one text per entry; pen writes, microphone dictates, holding it records audio.
- v4 (2026-10-27): one engine setting for memos and notes: phone (live while recording), own
  key, or cloud function.
- v3 (2026-10-27): dictation into the note with the phone's own speech recognition, "Open in
  Claude", long-press menu on entries.
- v2 (2026-10-26): transcription with the user's own key straight from the phone (Mistral,
  ElevenLabs, Deepgram, OpenAI), no cloud project needed.
- v1 (2026-10-26): first version. Segmented, crash-safe, encrypted recorder; lock (PRF, gate,
  PIN); transcription through the app's own Edge Function (OpenAI or Deepgram); encrypted cloud
  copy; encrypted backup file; Markdown export; end-to-end test in headless Chromium.
