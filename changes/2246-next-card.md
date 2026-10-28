---
section: Added
---
- **An agent that finishes a card is told which one to start next.** When an agent stops working on a card — finishes it, sends it for confirmation, blocks or cancels it — the `task` tool's answer names its next ready card (`next: M-14 "…" (high) is ready — start it: move M-14 to claimed; 2 more ready (task mine)`), in `task mine`'s order: by priority, its own before one nobody has under a main task it coordinates. Cards assigned while it was busy no longer wait until it happens to look. Nothing is said while it is still at its limit of cards in progress.
