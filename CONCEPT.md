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
