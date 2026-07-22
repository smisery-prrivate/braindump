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
