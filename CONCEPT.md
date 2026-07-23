# Braindump App — Concept (from Pat's Claude thread, 2026-07-16)

## Core principle: asymmetric friction
Input is frictionless; access and prioritization are deliberately effortful.
Everything goes in without judgment; only what passes a ritual comes out.

## The two stages
1. **Working memory** = "My Five" — the currently prioritized items, always visible.
2. **Archive** = master store of every dumped thought, locked by default.

## Flow
- **Braindump:** one field, type (or speak), send, gone. Only a counter ticks up. No sorting.
- **Archive is closed by default.** Opening costs effort (e.g. password entry — friction by design, not security).
- **Prioritize inside the open archive:**
  - Single tap → light background = "secondary / I'll do it too"
  - Double tap → dark background = "essential / existential"
  - **Hard limit: 5 marked items total** (light + dark combined). A sixth attempt shakes and blocks.
- **Close the lock** → back to the one main view.

## Main view (single screen)
- Braindump input field on top (with send button, teal when text present).
- **My Five directly underneath**: essentials dark and heavy on top, light ones below.
- The five never change on their own; only an archive visit changes them.
- Empty state: short hint instead of blank space.

## Decay / self-cleaning archive
- **Unprioritized** thoughts fade continuously with age (full strength first ~2 days,
  then progressively paler) and are **deleted after 30 days**.
- Prioritized items never fade and never expire — selecting = saving.
- Prototype had a time-lapse tester (+7 / +30 days) to feel the decay.

## Guest slots (v2, 2026-07-22)
The five stay hard. When they are full, another tap in the archive makes a **guest**:
- Max 3 guests, amber/dashed look, shown under the five on the main view.
- Each guest expires individually 3 days after being marked (fades visibly), then falls
  back into the archive. Guest status pauses the 30-day deletion but never resets it.
- **One guest life per thought** (guestUsed flag). Afterwards: promote into the real five
  (double tap, if a slot is free) or dump it anew. Extending is deliberately impossible.
- Decision: individual expiry instead of a complete reset — a shared reset date would
  arbitrarily punish whatever was marked shortly before it.

## Letting go (v3, 2026-07-22)
Friction only for prioritizing, never for letting go. Every card — in the five, guests,
and archive — has a ✓ button that deletes instantly, with a 5-second undo toast against
accidental taps. Deleting from the five frees a slot; goal is minimal storage.

## Direct access (v4, 2026-07-22)
- Big floating mic button (84px, teal FAB) bottom-center on the main view — voice is
  the primary input. Red pulse while listening.
- Tapping a card in "My Five" flips its weight (light <-> dark) without the archive
  ritual. The ritual still guards *selection* (adding/removing); shading is free.
- Storage answer for Pat: everything lives in localStorage on the device, no server,
  no sync; clearing site data deletes it. Backup/export is a future feature.

## Fade + bulk input (v5, 2026-07-22)
- Fade changed per Pat: full strength until day 20, then visible fade-out to day 30
  with "läuft in X T ab" countdown from day 20 (was: subtle fade from day 2).
- Multiline paste/dump: one thought per line.
- #import=<urlencoded JSON array> in the URL hash bulk-imports thoughts on load
  (hash never reaches the server, so thoughts stay private); hash is stripped after.

## Real countdown (v6, 2026-07-22)
The decay was always real (created-timestamps in localStorage, evaluated against the
real clock on load) — but Pat couldn't tell, and long-open sessions never refreshed.
v6: time-lapse test panel removed from the MVP; a real ticker re-purges and re-renders
every 60s and on visibilitychange, so fading/expiry happen even if the app stays open.

## One-thumb layout (v7, 2026-07-22)
Input row + send live in a fixed dock at the BOTTOM of the main screen; the mic FAB
floats directly above it. Flow: thumb taps mic -> speak -> text lands in the field
below -> correct if needed -> send, all in thumb reach. Archive access moved to a
pill button in the header (with live count); the five + guests scroll behind the dock.

## Guest popup + bugfix (v9, 2026-07-22)
Regression: v6's cleanup removed simNow() but tryGuest still called it — every guest
attempt died silently since v6 (Pat noticed: "Gäste kommen nicht mehr"). Fixed.
New per Pat: tapping an item while the five are full now opens an explicit popup —
"Als Gast dazu?" with confirm/cancel; one-shot-guest and all-full cases get an
info popup instead of the old shake-only feedback.

## Data safety + drag-back (v10, 2026-07-23)
People besides Pat now use the app.
- navigator.storage.persist() requested on boot (browser must not evict the data).
- Automatic second copy in IndexedDB on every save; if localStorage turns up empty
  on boot, the app silently restores from the mirror ("Aus Sicherung wiederhergestellt").
- Manual backup: archive screen gets "Backup speichern" (JSON download, dated) and
  "Laden" (file picker, merges + dedupes by id) with a last-backup hint.
- Drag-back: every five/guest card has a ⠿ handle; dragging it lifts a clone, a drop
  zone replaces the dock ("Loslassen: zurück ins Archiv"), dropping demotes the item
  (priority + guest cleared). Handle taps never flip priority; scrolling stays intact
  because touch-action:none sits only on the handle.
- Real cloud sync across devices = post-MVP (needs a server + accounts).

## English + long-press (v11, 2026-07-23)
- Drag & drop (v10) replaced: it worked poorly on phones. Now LONG-PRESS (500ms) on a
  five/guest card opens a confirm modal "Back to the archive?" -> Move back / Cancel.
  Short tap still flips light/dark; moving the finger (scroll) cancels the press.
- Entire UI switched to English (Pat: users are not all German). Speech recognition
  language now follows the phone (navigator.language) instead of hardcoded de-DE.
- Archive header button slightly bigger (14px/11x17px) — deliberately still quiet,
  focus stays on dump + five.

## Open design decisions (from the thread)
- When a slot frees up (item deselected), should the app prompt to refill to five?
- Should viewing/touching an archived thought refresh its 30-day clock? (Currently: creation date only.)
- Should expiring thoughts get one quiet "last chance" surface, or vanish silently? (Currently: silent.)

## Known gaps to build
1. **Voice entry** (first missing feature — speak a thought, it lands as an entry)
2. **Real persistence** (prototype was session-memory only)

## Prototype reference
Clickable artifact in the shared thread (demo password 1234) — behavior spec above
captures everything it did.
