# Task board: projects, main and sub tasks, the person's confirmation

Status: step 1 (this change) — the board's model, rules and the Fleet › Tasks page. Steps 2 and 3 below.
Ported from taskhall (任務會所), a board an AgEnD fleet ran beside AgEnD; its rules are kept, its plumbing is AgEnD's.

## Why

The fleet's task board was a flat list: a title, a description, a priority, an assignee; claim, done. Multi-step work
did not fit it, and nothing in it waited for the person:

- An outcome the person wants ("a leaderboard") is several steps, often for several instances (a developer and a
  reviewer; a server and a client). The steps need an owner each and an order, and the outcome needs its progress.
- An instance that finishes work marked it done itself. Work the person has to accept needs to stop and wait for them.
- An instance whose context is reset, or another instance taking over, needs the state of the work on the card, not
  in a conversation that is gone.

## Model

| | |
|---|---|
| Project | A group of related work, created by the person (name, description, archived). |
| Main task (M-n) | An outcome. In a project, or in none ("No project": every `task` tool task for now). |
| Sub task (S-n) | A step of a main task; not split further. Its project is its main task's. |

Cards keep the `tasks` table's columns and add: `code` (M-n / S-n, never reused), `kind`, `project_id`, `parent_id`,
`scope`, `acceptance` (a checklist, JSON), `context`, `state`, `blocked_reason`, `size`, `needs_review`, `version`,
`sort`, `started_at`, `submitted_at`, `done_at`, `seen_entry_id`. `description` is the card's goal; `depends_on` stays
a JSON array of task ids. New tables: `task_projects`, `task_entries` (comments, the progress log, send-back and
confirm notes), `task_events` (history: who changed what, from what, to what) and `task_counters`.

Statuses are the tool's (`open`, `claimed`, `blocked`, `done`, `cancelled`) plus `review`: finished, waiting for the
person. The page names them To do, In progress, Blocked, Waiting for you, Done.

Field limits (code points) keep a card cheap for an agent to read: title 100, goal 300, scope 600, acceptance 10 ×
150, context 1000, state 500 in at most 5 lines, blocked reason 400, result 1000, comment 4000.

## Rules (scheduler/task-board.ts)

One rule set for every writer — the page, the `task` tool, a script. The actor is a person, an instance, a script
or the board itself.

- **The person's confirmation.** `needs_review` cards stop at `review` when finished. A main task opened by a person
  needs review unless they untick it; an instance cannot open one that skips it, and only a person clears the flag.
  Only a person moves a card from `review` to `done` (an approve note when they add one) or sends it back (a reason,
  stored as a send-back entry the assignee reads first). On the `task` tool, `done` (or `update status=done`) on such
  a card is `review`. Only a person reopens finished work — including by adding a sub task to a done main task.
- **Main tasks follow their sub tasks.** With sub tasks (not cancelled), a main task is `open` until one starts,
  `claimed` while they run, and `review` (or `done`, when it skips review) when all are done. An instance moves the
  sub tasks, not the main task: it may block it, resubmit it after a send-back with a result, or cancel one it opened.
  A new sub task reopens a finished main task. Cancelling a main task cancels its unfinished sub tasks; restoring it
  brings back what the cancel took down.
- **Instances move their own cards.** Claiming takes an unassigned card (it becomes the instance's) or its own, never
  another's; finishing takes a result, and unchecked acceptance items a reason; putting a card back clears its
  assignee; an instance edits only cards it owns or opened (anyone comments); it cannot drop someone else's unfinished
  dependency or reopen a finished card. A person moves anything; only the reasons are required of them.
- **Dependencies.** Only `done` meets a dependency — a cancelled one still holds, as the `task` tool always had it —
  and a sub task also waits for its main task's. Cycles, counting the main/sub waits, are refused.
- **Versions.** Every content change bumps `version`; a write carrying an older version is refused (409, with who
  changed the card last). Reordering does not bump it.
- **The `task` tool on the board's cards.** A card in a project, a sub task, one with sub tasks or one waiting for
  the person holds an instance to these rules through the tool too (claim, done and update go through the same
  move checks; result and priority are its owner's; reassigning is its owner's or creator's). The tool's own tasks
  outside all of that move as they always have. `id` takes a card number; `list` counts `review` as live.
- **Comments an assignee has not seen.** Comments and send-backs by others after the assignee's last write are new to
  it; its next write returns them first (`notes`), so a comment posted mid-task is never acknowledged unread.

## Who is the person

A dashboard request is the person only through a signed-in session (`via: "session"`). The header token is the CLI's
or a script's, and any agent on the machine can read the token file; a token request is the actor `script`
("web-token"), held to an instance's rules. The board's own routes (`/ui/tasks/board`, `/ui/tasks/cards…`,
`/ui/tasks/projects…`) refuse token writes (403); the old `/ui/tasks` routes keep working for scripts, under the
rules. Guests reach none of these routes (not in GUEST_ROUTES), and the `tasks` stream event is not sent to them.

## Storage and other releases

All schema changes are additive. `migrate()` runs on every open: it adds missing columns (a concurrent "duplicate
column" from the CLI opening the file at the same moment is fine), creates the tables, numbers every row without a
`code` (in the order opened: rows from before the board, and rows a release without the board wrote since), drops
entries and events whose task is gone, and lets main tasks catch up with sub tasks moved meanwhile. A release without
the board reads and writes the same rows and ignores the new columns; `review` is just a status it does not list by
default.

Retention (`retention_days`) prunes old finished tasks only outside the board's projects and families — the board is
the person's record — and removes a pruned task's entries and events with it.

## The page (Fleet › Tasks)

`fleet-tasks.js` (Home and a project's board), `fleet-task-card.js` (one card in the app's dialog),
`fleet-task-common.js` (words, requests, moves, marks). Home: what waits for the person (confirm, send back, answer),
then the projects (with % done) and No project. A board read carries live cards and the last 14 days' finished ones
(`?done=all`: every done main task, for the Done column's "All"), each project's numbers over all its cards, and is a
handful of statements whatever its size (`views()`, `projectStats()`). A project: its main tasks by status, a filter by assignee, drag to
move or reorder, a main task's sub tasks inside its tile. A card: every field edits in place with the version it
started from; a 409 shows the newer card with the draft still open, and saving again overwrites. `?card=M-3` opens a
card. Bars are SVG rects (the CSP allows no style attribute). The page reads the board again on each `tasks` stream
event (once per burst) and when the stream reconnects.

## Next

- **Step 2 — agents.** The `task` tool learns the board: `mine` (an agent's work: in progress, blocked, ready,
  waiting, new comments, sent back), `move`, comments and the card fields, with compact text answers (one line per
  card) and the card-writing rules in the tool's description. Waking an assignee when someone else moves their card
  (assigned, sent back, commented, answered, its dependencies done) through the fleet's own delivery, ten seconds of
  events per instance in one message.
- **Step 3 — the person.** Cards waiting for review or blocked in Needs you and the fleet's notification channel; a
  daily summary; importing a taskhall database.
