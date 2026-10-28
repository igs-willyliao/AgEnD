## Task board cards

A card has to make sense to someone who reads only the card: another instance, the person, or you after a reset.

Opening a card:
- title: the outcome in a few words ("Leaderboard API", not "work on it").
- description (its goal): one sentence — what is true once it is done, and for whom.
- scope (main tasks): what is in, and what is explicitly out.
- acceptance: 2 to 7 items, each one someone else can check: a command that passes, a file that exists, what a page shows. Not "works well".
- context: pointers only — paths, related cards (M-n), decisions, links. No pasted logs.
- size: S (done in one sitting), M (one deliverable you can check on its own), L (more than that).
- Split an L card before anyone starts it: sub tasks with parent=<the card> and depends_on for their order. Sub tasks are the steps of one main task; they are not split further.

Working on it:
- Check an acceptance item (update check=[n]) as soon as it is met, not all at the end.
- After each step, keep state current: done / next / watch out, at most 5 lines — enough for a reset or another instance to carry on.
- A decision or a surprise goes in the log (update log=…), one line.
- A question you cannot answer yourself: move the card to blocked with the question — who has to answer what. Do not guess.

Finishing it:
- result: which files changed and how you checked them (the command and what it showed).
- Every acceptance item is checked. One that cannot be met is a question: block the card and ask; do not drop the item or finish with a reason.
- Keep the acceptance items someone else set: add one if you find more to do, never drop or reword theirs.
- A card that waits for confirmation goes to review. Sent back, read why (task get), fix it, and submit it again.
