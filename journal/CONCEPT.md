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
- **Record, then text.** The microphone on the home screen records into a new entry; Record
  inside an entry adds another recording below the ones there. Each recording is its own block
  above the text: play, 10 s back and on, a slider, speeds 0.5 to 2, and the state of its text.
  When a recording stops, its text is written from the recording and appended to the entry's
  text (one text per entry; you can edit it; text that arrives while you type is appended, your
  typing is kept). Nothing listens live while it records: the phone's own speech recognition in
  the browser stopped at every pause and, on Android, could not run beside a recording, so it is
  gone (v25).
- **Transcribe.** One setting (Menu, Transcription) decides how recordings become text.
  *On this phone (Whisper)*, the default: Whisper runs in the browser in a worker; the audio
  never leaves the phone. The library (Transformers.js) and its WebAssembly runtime (ONNX
  Runtime) are part of the app (`vendor/`, versions and hashes in its README), so no script comes
  from another server; only the model's weights (data) are downloaded once from Hugging Face and
  kept in the browser's cache. Fast model about 80 MB, better German about 250 MB. Transformers.js
  does not detect the language, so Whisper is asked once per part, on its first 30 seconds,
  whether it hears German or English. Stock phrases Whisper invents over silence (subtitle
  credits) are dropped. Whisper starts when the recording stops, never while it records.
  *Own key*: Mistral (EU), ElevenLabs, Deepgram or OpenAI, entered once, stored encrypted in the
  vault; each part goes straight from the phone to the service. *Own cloud function*: sign in,
  the key stays on the server (see below). Parts are transcribed one after the other. A refused
  part is retried after a growing pause (1, 4, 16 … minutes, an hour at most) and the recording
  says why meanwhile. Setting: text automatically (the default), ask after each recording, or
  audio only. *Claude app* and *keyboard microphone* record nothing: the microphone opens the
  Claude app, or the text window with the keyboard up.
- **Long press** on an entry in the list picks it (pick mode, below). Share and Claude live inside
  the entry.
- **Date.** The date chip in the entry opens the phone's date and time picker: a memo added
  afterwards gets the day it belongs to and moves to its place in the list.
- **Save.** The entry has a Save button: it stores and says "Saved"; you stay in the entry. Text is
  also stored on its own while typing, on Back and when the app goes to the background.
- **Several at once.** "Select" in the header (or a long press) turns
  the list into a pick list: a tap picks, the bar at the bottom deletes all picked entries (one
  undo for the whole batch) or moves them to a folder.
- **Folders.** Chips above the list: All, every folder, "+ Folder". A chip filters the list and
  new entries made while it is open land in that folder. Long press on a chip renames or deletes
  the folder (its entries stay, without a folder). In the entry, the folder chip under the date
  moves the entry. The folder list is sealed in the `meta` store (`jn|folders`), the folder name
  travels inside the sealed entry.
- **Photos.** Every entry has a photo grid: "+" takes one from the camera or the gallery. The
  photo is shrunk on the phone to at most 1600 px as JPEG, which also drops all camera metadata
  (location included), stored sealed like an audio segment, with a 160 px thumbnail inside the
  entry record for the list and the grid. A tap shows the photo full size (decrypted into memory
  only), with Delete. Photos travel in the backup file and in the cloud copy like segments.
- **Search and export.** The search field above the list looks in every folder: title, text,
  folder name and date ("november", "dienstag"), accents ignored ("uber" finds "über"), every
  word must occur; hits are marked. "Export" next to it saves the hits as one plain text file;
  Menu, Backup exports everything the same way (or as Markdown), oldest entry first, not
  encrypted, after a warning.
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
- **Transcription is the one place audio can leave the device, and only by your choice.** With
  Whisper (the default) it does not: the audio stays on the phone. With an
  own key a segment goes, over TLS, straight to the chosen service; the key sits sealed in the
  `meta` store (`jn|stt`) and is re-encrypted with every key change like everything else. With
  the cloud function a segment goes to the app's own Supabase Edge Function, which checks the sign-in, optionally
  allows only listed e-mail addresses, hands the audio to the transcription provider and returns
  the text. The function stores nothing and the provider's key never reaches the phone. The
  provider may keep audio for a while under its own terms (OpenAI: up to 30 days for abuse
  monitoring unless zero data retention is granted; Deepgram: see its terms). The returned text is
  stored encrypted like everything else. "Never (audio only)" keeps everything on the device.
- **Nothing else leaves the device.** No cookies, no analytics, no third-party scripts or fonts.
  The Content-Security-Policy in `index.html` allows connections to the app's own origin, the
  one Supabase project, the transcription services and Hugging Face (the Whisper model's weights,
  data only), and no inline script. The page refuses to run inside another site's frame.
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

An entry: `{ id, created, updated_at, title, text, lang, mime, segs, pics, folder, state, dur,
deleted, del_at, tx, merged }` (a photo: `{ id, mime, size, w, h, th, t }`) (`transcript` and `tEdited` are folded into `text` by `mergeText` since v5) plus local marks (`cloud`, `srv`, `pushed_at`, `up`, `purged`). A
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

- v26 (2026-11-08): search is always there and looks in every folder, in title, text, folder
  name and date, accents ignored, hits marked; everything (or the search hits) exports as one
  plain text file, oldest first.
- v25 (2026-11-03): Whisper on the phone, the new default: record, then the text is written
  from the recording on the phone, nothing leaves it. Recordings are blocks above the text, each
  with its own player; Record inside an entry adds one. The browser's live dictation is gone.
  Fix: a redraw no longer overwrites text that a transcription has just added (since v16).
- v24 (2026-11-03): the microphone always records the voice (kept, playable), whatever the
  engine (except Claude and keyboard); its text comes online with a key, or live only where the
  phone has shown it can listen while it records (the voice comes first). Dictate inside an entry
  stays for the phone's live text. "Get text online" explains the key in the entry.
- v23 (2026-11-02): dictation was silent on a real phone (the Google tone, then no words): when the
  app tries the voice recording or on-device recognition and no word comes within 4 s, dictation
  goes back to the plain way and the phone keeps it so; a silent recording is also recognised by
  its compressed size. The text card shows a red "Listening" while dictating.
- v22 (2026-11-01): dictation uses Chrome's recognition on the phone itself where offered (no
  network, no tones); a language pack that can be downloaded is fetched for the next dictation;
  menu shows German and English state; a check that kills the page is never tried again.
- v21 (2026-11-01): the backup password is asked twice; every password form carries a fixed
  name for password managers ("Journal app lock", "Journal backup", "Journal cloud copy"), so
  Proton Pass and others file it under that name instead of "GitHub" and fill it on the lock screen.
- v20 (2026-11-01): dictation keeps the voice: the same microphone is recorded while the phone
  writes (newer Chrome feeds the recognition from the recording), stored encrypted as the entry's
  audio; where a phone cannot do both it notices, keeps the text going and remembers it. Player
  with 10 s back and on, speeds 0.5 to 2. Save stays in the entry. Dictated text is stored every
  few seconds while dictating.
- v19 (2026-10-31): Claude button while dictating sent nothing ("Nothing to send yet"): dictation
  now stops first and its text goes along; an empty entry opens a new Claude chat.
- v18 (2026-10-31): as long as no lock is set, a red line on the home screen sets it in one tap
  (fingerprint or the phone's screen lock: pattern, PIN, face); App lock moved to the top of the menu.
- v17 (2026-10-30): the entry's date and time can be changed (date chip in the entry, the phone's
  own picker), for memos added afterwards; the list re-sorts, the date travels in backup and cloud.
- v16 (2026-10-30): Save button in the entry; stopping dictation keeps the last phrase that was
  still provisional (it was lost on Back); typing stops dictation; the field is stored before any
  redraw, on blur and when the app goes to the background. Long press goes straight to pick mode.
- v15 (2026-10-28): keyboard engine: the microphone opens the text window with the keyboard up,
  the keyboard's own voice typing (Gboard) does the listening.
- v14 (2026-10-28): pick mode: delete or move several entries at once.
- v13 (2026-10-28): folders and photos.
- v12 (2026-10-27): no recording screen: the microphone opens the text window, the engine decides
  what runs behind it; Claude engine; interim words overlaid, tolerant overlap.
- v11 (2026-10-27): one gesture: the microphone records, always; Claude button in the entry.
- v6 to v10 (2026-10-27): Android's speech recognition tamed (repeated and growing results folded
  on their overlap, sessions restarted at once), the microphone follows the engine, "Open in
  Claude" runs inside the tap.
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
