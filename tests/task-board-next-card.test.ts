/**
 * An agent that stops working on its card — finished it, sent it for confirmation, blocked it, cancelled it — hears in
 * the same answer which card it can start next. Nothing else told it: its own move wakes nobody, and a card assigned
 * while it was busy was told once, long before. The next card is the first ready one in `task mine`'s order (by
 * priority, then place): its own first, else one nobody has under a main task it coordinates. Nothing is said while it
 * is still at its limit of cards in progress, when nothing is ready, or for a move that is not its own stop.
 *
 * Isolation: temp databases; a FleetManager with no fleet (nothing starts) for the `task` tool's two doors.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SchedulerDb } from "../src/scheduler/db.js";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { Actor, TaskBoard } from "../src/scheduler/task-board.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const LEAD: Actor = { kind: "instance", name: "lead" };
const DEV: Actor = { kind: "instance", name: "dev" };

const dirs: string[] = [];
const dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fleet() {
  const d = mkdtempSync(join(tmpdir(), "next-card-")); dirs.push(d);
  writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
  const fm = new FleetManager(d);
  const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
  (fm as unknown as Record<string, unknown>).scheduler = scheduler;
  dbs.push(scheduler.db);
  const b: TaskBoard = scheduler.db.board;
  // The IPC door answers on the instance's IPC client: its one response is the answer.
  const ipc = (args: Record<string, unknown>) => {
    const got: Array<Record<string, unknown>> = [];
    const raw = fm as unknown as { instanceIpcClients: Map<string, unknown>; handleTaskCrud(name: string, msg: Record<string, unknown>): void };
    raw.instanceIpcClients.set("dev", { send: (m: Record<string, unknown>) => { got.push(m); return true; } });
    raw.handleTaskCrud("dev", { fleetRequestId: "r1", payload: args, meta: { instance_name: "dev" } });
    return got[0]?.result;
  };
  return { b, http: (args: Record<string, unknown>) => fm.handleTaskCrudHttp("dev", args), ipc };
}

/** dev at work on M-1, with M-2 (normal), M-3 (high) and M-4 (waiting for M-2) to do — and Ann's M-5 for someone else. */
function day(b: TaskBoard) {
  const [m1, m2, m3] = b.createCards(ANN, { cards: [
    { title: "Leaderboard", assignee: "dev", needsReview: false },
    { title: "Profile page", assignee: "dev", needsReview: false },
    { title: "Login fix", assignee: "dev", priority: "high" },
    { title: "Shop", assignee: "dev", dependsOn: ["#2"] },
    { title: "Theirs", assignee: "rev", priority: "urgent" },
  ] }).cards;
  b.moveCard(DEV, m1!.code, "claimed");
  return { m1: m1!, m2: m2!, m3: m3! };
}
const NEXT_M3 = 'next: M-3 "Login fix" (high) is ready — start it: move M-3 to claimed; 1 more ready (task mine)';

describe("the answer to an agent's stop names its next card", () => {
  it("finishing it with move: the highest priority ready card, and how many more", async () => {
    const { b, http } = fleet();
    day(b);
    expect(await http({ action: "move", id: "M-1", to: "done", result: "src/board.ts; tests pass" })).toBe(`ok M-1 in progress → done (v3)\n${NEXT_M3}`);
  });

  it("the tool's own done, over both doors: the board's notes carry it", async () => {
    for (const door of ["http", "ipc"] as const) {
      const f = fleet();
      day(f.b);
      const answer = await f[door]({ action: "done", id: "M-1", result: "src/board.ts; tests pass" });
      expect(answer, door).toMatchObject({ notes: [NEXT_M3] });
    }
  });

  it("sending it for the person's confirmation, blocking it and cancelling it are stops too", () => {
    const { b } = fleet();
    const { m2, m3 } = day(b);
    b.moveCard(DEV, "M-1", "blocked", { reason: "which API?" });
    expect(b.takeNotes()).toEqual([NEXT_M3]);
    b.moveCard(DEV, m3.code, "claimed");
    const review = b.moveCard(DEV, m3.code, "review", { result: "fixed" });
    expect(review.notes).toEqual(['next: M-2 "Profile page" is ready — start it: move M-2 to claimed']);
    const own = b.createCards(DEV, { cards: [{ title: "Spike" }] }).cards[0]!;
    b.moveCard(DEV, own.code, "claimed");
    expect(b.moveCard(DEV, own.code, "cancelled", { reason: "not needed" }).notes).toEqual(['next: M-2 "Profile page" is ready — start it: move M-2 to claimed']);
    // With M-2 done, the card that waited for it is next.
    b.moveCard(DEV, m2.code, "claimed");
    expect(b.moveCard(DEV, m2.code, "done", { result: "page" }).notes).toEqual(["M-4's dependencies are all done; it can start", 'next: M-4 "Shop" is ready — start it: move M-4 to claimed']);
  });

  it("a coordinator: a sub task nobody has under its main task, when none is its own", () => {
    const { b } = fleet();
    const main = b.createCards(ANN, { cards: [{ title: "Checkout", assignee: "lead" }] }).cards[0]!;
    const [mine] = b.createCards(LEAD, { parent: main.code, cards: [{ title: "Cart", assignee: "lead" }, { title: "Pay", assignee: null }] }).cards;
    b.moveCard(LEAD, mine!.code, "claimed");
    expect(b.moveCard(LEAD, mine!.code, "done", { result: "cart.ts" }).notes)
      .toEqual([`next: S-2 "Pay" is ready (unassigned, a sub task of your ${main.code}: take it or assign it) — start it: move S-2 to claimed`]);
  });

  it("nothing is said when nothing is ready, while it is still at its limit, or for a move that is not its own stop", () => {
    const { b } = fleet();
    const solo = b.createCards(ANN, { cards: [{ title: "Only one", assignee: "dev", needsReview: false }, { title: "Later", assignee: "dev", dependsOn: ["#1"] }] }).cards[0]!;
    b.moveCard(DEV, solo.code, "claimed");
    expect(b.moveCard(DEV, solo.code, "blocked", { reason: "which?" }).notes).toEqual([]);     // Later waits for it
    // A person moved two of its cards to in progress: stopping one leaves it at its limit of one.
    const [a, c] = b.createCards(ANN, { cards: [{ title: "A", assignee: "dev", needsReview: false }, { title: "C", assignee: "dev", needsReview: false }, { title: "D", assignee: "dev" }] }).cards;
    b.moveCard(ANN, a!.code, "claimed"); b.moveCard(ANN, c!.code, "claimed");
    expect(b.moveCard(DEV, a!.code, "done", { result: "a" }).notes).toEqual([]);
    expect(b.moveCard(DEV, c!.code, "done", { result: "c" }).notes).toEqual(['next: M-5 "D" is ready — start it: move M-5 to claimed']);
    // The person finishing an agent's card, or an agent confirming one it handed out: not that agent's stop.
    const { b: b2 } = fleet();
    day(b2);
    expect(b2.moveCard(ANN, "M-1", "done").notes).toEqual([]);
    const handed = b2.createCards(LEAD, { cards: [{ title: "Handed", assignee: "dev", needsReview: true }] }).cards[0]!;
    b2.moveCard(DEV, "M-2", "claimed");
    b2.moveCard(DEV, "M-2", "blocked", { reason: "later" });
    b2.moveCard(DEV, handed.code, "claimed");
    b2.moveCard(DEV, handed.code, "review", { result: "done" });
    expect(b2.moveCard(LEAD, handed.code, "done").notes).toEqual([]);
    // Opening, starting or sending back a card is no stop either.
    expect(b2.moveCard(DEV, "M-3", "claimed").notes).toEqual([]);
  });
});
