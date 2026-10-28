# Task board card rules (a systemPrompt)

[繁體中文](task-board-card-rules.zh-TW.md)

How to fill in a task board card so that the card alone carries the work: what it is for, what done means, where it
stands. Give these rules to your agents as part of their `systemPrompt`; turn on `board_cards_strict` too, and the
board refuses a card that breaks the main ones instead of only asking for them.

1. Copy [card-rules.md](task-board-card-rules/card-rules.md) (or the [繁體中文](task-board-card-rules/card-rules.zh-TW.md)
   version) somewhere the fleet can read it, for example `~/.agend/card-rules.md`.
2. Add it to the agents' `systemPrompt` in fleet.yaml:

   ```yaml
   defaults:
     systemPrompt: "file:~/.agend/card-rules.md"
     board_cards_strict: true        # optional: the board holds them to it
   instances:
     reviewer:
       systemPrompt: "file:prompts/reviewer.md, file:~/.agend/card-rules.md"   # its own prompt replaces the default's: name both
       board_cards_strict: false     # opens a card of its own for each review
   ```

   An agent with a `systemPrompt` of its own does not get the default's; list both parts, joined with a comma
   ([systemPrompt file paths](../features.md#systemprompt-file-paths)).
3. Restart the agents (the prompt is read at start). `board_cards_strict` applies at once.

What `board_cards_strict` enforces ([configuration](../configuration.md)): an agent held to it opens no card without a
goal and acceptance items, starts none that lacks them or is size L, finishes none with an item unchecked (a reason
does not excuse it), and keeps the items someone else set. The rules file says the rest: what a good item is, keeping
`state` current, the log, and what goes in the result.
