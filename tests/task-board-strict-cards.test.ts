/**
 * Strict cards (`board_cards_strict`, per instance, from the defaults too): an agent held to them works on filled-in
 * cards, so a card read cold says what it is for and what done means, and done means every item was met.
 *
 *   1. It opens no card without a goal and acceptance items — nor a `task` tool task, which has neither.
 *   2. It starts no card that lacks them, or is size L (split it first).
 *   3. It finishes none with an acceptance item unchecked, whatever the reason; none without items at all.
 *   4. It keeps the items someone else set: it may add, not drop or reword.
 *   5. A person, and an agent not held to them, work as before. The fleet reads the setting at each write; the
 *      agent's instructions say so (the built-in task board section).
 *
 * Isolation: temp databases; a FleetManager with no fleet (nothing starts) for the `task` tool and the wiring.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerDb } from "../src/scheduler/db.js";
import { Scheduler } from "../src/scheduler/index.js";
import { TaskBoardError, type Actor, type TaskBoard } from "../src/scheduler/task-board.js";
import { FleetManager } from "../src/fleet-manager.js";
import { STRICT_CARDS_GUIDANCE, buildFleetInstructions } from "../src/instructions.js";
import { loadFleetConfig } from "../src/config.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { instanceFieldImpact } from "../src/instance-config-impact.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const DEV: Actor = { kind: "instance", name: "dev" };
const LEAD: Actor = { kind: "instance", name: "lead" };
const FREE: Actor = { kind: "instance", name: "free" };

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const c of closers.splice(0)) { try { c(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "strict-cards-")); dirs.push(d); return d; };

/** dev and lead are held to strict cards; free is not. */
function board(): TaskBoard {
  const db = new SchedulerDb(join(tmp(), "scheduler.db"));
  closers.push(() => db.close());
  db.board.setStrictCards((n) => n === "dev" || n === "lead");
  return db.board;
}

/** The refusal's key, or null when `fn` passes. */
function refused(fn: () => unknown): string | null {
  try { fn(); return null; } catch (err) {
    if (!(err instanceof TaskBoardError)) throw err;
    if (err.key?.startsWith("strict_")) expect(err.message).toMatch(/^(card \d+: )?strict cards: /);
    return err.key ?? err.message;
  }
}
const FILLED = { goal: "players see the weekly top 100", acceptance: ["resets on Monday", "shows the player's rank"] };

describe("1. no card opened without a goal and acceptance items", () => {
  it("each is needed, in a batch too (none of it is opened); a person and an agent not held to it are not refused", () => {
    const b = board();
    expect(refused(() => b.createCards(DEV, { cards: [{ title: "Leaderboard", acceptance: ["resets on Monday"] }] }))).toBe("strict_fields");
    expect(refused(() => b.createCards(DEV, { cards: [{ title: "Leaderboard", goal: "top 100" }] }))).toBe("strict_fields");
    expect(refused(() => b.createCards(DEV, { cards: [{ title: "Leaderboard", goal: "  ", acceptance: ["x"] }] }))).toBe("strict_fields");
    expect(refused(() => b.createCards(LEAD, { cards: [{ title: "API", ...FILLED, assignee: "dev" }, { title: "Page", assignee: "dev" }] }))).toBe("strict_fields");
    expect(b.listCards({}).total).toBe(0);
    expect(b.createCards(DEV, { cards: [{ title: "Leaderboard", ...FILLED }] }).cards[0]!.acceptance).toHaveLength(2);
    expect(b.createCards(ANN, { cards: [{ title: "Quick one", assignee: "dev" }] }).cards).toHaveLength(1);
    expect(b.createCards(FREE, { cards: [{ title: "Quick one" }] }).cards).toHaveLength(1);
  });

  it("the `task` tool's own task (no fields to fill) is refused with how to open it instead", () => {
    const b = board();
    expect(refused(() => b.legacyCreate(DEV, { title: "Ping", description: "say hi" }))).toBe("strict_fields");
    expect(b.legacyCreate(FREE, { title: "Ping" }).title).toBe("Ping");
  });
});

describe("2. no card started that is not filled in, or is size L", () => {
  it("a person's quick card: the agent fills it in, then starts it — by move and by the tool's claim", () => {
    const b = board();
    const card = b.createCards(ANN, { cards: [{ title: "Fix login", assignee: "dev" }] }).cards[0]!;
    expect(refused(() => b.moveCard(DEV, card.code, "claimed"))).toBe("strict_start");
    expect(refused(() => b.legacyClaim(DEV, card.uuid, "dev"))).toBe("strict_start");
    b.updateCard(DEV, card.code, { goal: "login works again", acceptance: ["the reported account logs in"] });
    expect(b.moveCard(DEV, card.code, "claimed").card.status).toBe("claimed");
  });

  it("size L: split first — a main task into sub tasks, a sub task into more of its main task's", () => {
    const b = board();
    const main = b.createCards(ANN, { cards: [{ title: "Shop", ...FILLED, size: "L", assignee: "dev" }] }).cards[0]!;
    try { b.moveCard(DEV, main.code, "claimed"); expect.unreachable(); } catch (err) {
      expect([(err as TaskBoardError).key, (err as Error).message]).toEqual(["strict_size_l", expect.stringContaining(`task create parent=${main.code}`)]);
    }
    const [sub] = b.createCards(DEV, { parent: main.code, cards: [{ title: "Cart", ...FILLED, size: "L" }, { title: "Pay", ...FILLED, size: "M" }] }).cards;
    try { b.moveCard(DEV, sub!.code, "claimed"); expect.unreachable(); } catch (err) {
      expect((err as Error).message).toContain(`open its parts as sub tasks of ${main.code}`);
    }
    expect(b.moveCard(DEV, "S-2", "claimed").card.status).toBe("claimed");
  });

  it("a person moving it, and an agent not held to it, start it as before", () => {
    const b = board();
    const [a, c] = b.createCards(ANN, { cards: [{ title: "A", assignee: "dev", size: "L" }, { title: "C", assignee: "free", size: "L" }] }).cards;
    expect(b.moveCard(ANN, a!.code, "claimed").card.status).toBe("claimed");
    expect(b.moveCard(FREE, c!.code, "claimed").card.status).toBe("claimed");
  });
});

describe("3. no card finished with an acceptance item unchecked", () => {
  it("a reason does not excuse it; checking them does — done, review, the tool's done", () => {
    const b = board();
    const [own, handed] = b.createCards(ANN, { cards: [{ title: "Leaderboard", ...FILLED, assignee: "dev", needsReview: false }, { title: "Profile", ...FILLED, assignee: "dev" }] }).cards;
    b.moveCard(DEV, own!.code, "claimed");
    b.updateCard(DEV, own!.code, { check: [1] });
    expect(refused(() => b.moveCard(DEV, own!.code, "done", { result: "board.ts", reason: "rank comes later" }))).toBe("strict_unchecked");
    expect(refused(() => b.legacyComplete(DEV, own!.uuid, "board.ts"))).toBe("strict_unchecked");
    b.updateCard(DEV, own!.code, { check: [2] });
    expect(b.moveCard(DEV, own!.code, "done", { result: "board.ts; tests pass" }).card.status).toBe("done");
    b.moveCard(DEV, handed!.code, "claimed");
    expect(refused(() => b.moveCard(DEV, handed!.code, "review", { result: "page", reason: "close enough" }))).toBe("strict_unchecked");
    b.updateCard(DEV, handed!.code, { check: [1, 2] });
    expect(b.moveCard(DEV, handed!.code, "review", { result: "page" }).card.status).toBe("review");
  });

  it("a card with no items at all (a person started it) needs them before it is finished", () => {
    const b = board();
    const card = b.createCards(ANN, { cards: [{ title: "Quick one", assignee: "dev", needsReview: false }] }).cards[0]!;
    b.moveCard(ANN, card.code, "claimed");
    expect(refused(() => b.moveCard(DEV, card.code, "done", { result: "x" }))).toBe("strict_no_acceptance");
  });

  it("its own card in review, and a main task its sub tasks finished: the one who confirms it is held too", () => {
    const b = board();
    const own = b.createCards(DEV, { cards: [{ title: "Spike", ...FILLED }] }).cards[0]!;
    b.moveCard(DEV, own.code, "claimed");
    expect(refused(() => b.moveCard(DEV, own.code, "review", { result: "notes" }))).toBe("strict_unchecked");
    const main = b.createCards(LEAD, { cards: [{ title: "Checkout", ...FILLED, assignee: "dev", needsReview: true }] }).cards[0]!;
    const sub = b.createCards(DEV, { parent: main.code, cards: [{ title: "Cart", goal: "a cart", acceptance: ["adds items"] }] }).cards[0]!;
    b.moveCard(DEV, sub.code, "claimed");
    b.updateCard(DEV, sub.code, { check: [1] });
    b.moveCard(DEV, sub.code, "done", { result: "cart.ts" });
    expect(b.getCard(main.code).status).toBe("review");                 // by itself, its sub tasks done
    b.updateCard(DEV, main.code, { result: "checkout works" });
    expect(refused(() => b.moveCard(LEAD, main.code, "done"))).toBe("strict_unchecked");
    // Sent back (a person sends back a main task that follows its sub tasks), its assignee resubmits it: the same.
    b.moveCard(ANN, main.code, "claimed", { reason: "check its items" });
    expect(refused(() => b.moveCard(DEV, main.code, "review"))).toBe("strict_unchecked");
    b.updateCard(DEV, main.code, { check: [1, 2] });
    expect(b.moveCard(DEV, main.code, "review").card.status).toBe("review");
    expect(b.moveCard(LEAD, main.code, "done").card.status).toBe("done");
  });

  it("control: an agent not held to it finishes with a reason, as before", () => {
    const b = board();
    const card = b.createCards(ANN, { cards: [{ title: "Leaderboard", ...FILLED, assignee: "free", needsReview: false }] }).cards[0]!;
    b.moveCard(FREE, card.code, "claimed");
    expect(b.moveCard(FREE, card.code, "done", { result: "board.ts", reason: "rank comes later" }).card.status).toBe("done");
  });
});

describe("4. the items someone else set are kept", () => {
  it("adding passes; dropping or rewording one is refused; its own card's are its own", () => {
    const b = board();
    const card = b.createCards(ANN, { cards: [{ title: "Leaderboard", ...FILLED, assignee: "dev" }] }).cards[0]!;
    expect(refused(() => b.updateCard(DEV, card.code, { acceptance: ["resets on Monday"] }))).toBe("strict_acceptance_kept");
    expect(refused(() => b.updateCard(DEV, card.code, { acceptance: ["resets on Monday", "shows a rank"] }))).toBe("strict_acceptance_kept");
    expect(b.updateCard(DEV, card.code, { acceptance: [...FILLED.acceptance, "loads in 1 s"] }).card.acceptance).toHaveLength(3);
    const own = b.createCards(DEV, { cards: [{ title: "Spike", ...FILLED }] }).cards[0]!;
    expect(b.updateCard(DEV, own.code, { acceptance: ["one thing"] }).card.acceptance).toHaveLength(1);
    const free = b.createCards(ANN, { cards: [{ title: "Free's", ...FILLED, assignee: "free" }] }).cards[0]!;
    expect(b.updateCard(FREE, free.code, { acceptance: ["one thing"] }).card.acceptance).toHaveLength(1);
  });
});

describe("5. the fleet's setting, the task tool and the instructions", () => {
  it("board_cards_strict, from the defaults or the instance's own; a boolean; applied without a restart", () => {
    const d = tmp(), file = join(d, "fleet.yaml");
    writeFileSync(file, `defaults:\n  board_cards_strict: true\ninstances:\n  dev:\n    working_directory: ${d}\n  rev:\n    working_directory: ${d}\n    board_cards_strict: false\n`);
    const c = loadFleetConfig(file);
    expect([c.instances.dev!.board_cards_strict, c.instances.rev!.board_cards_strict]).toEqual([true, false]);
    expect(validateFleetConfig({ defaults: { board_cards_strict: "yes" }, instances: { a: { board_cards_strict: 1 } } }).errors.map((e) => e.path))
      .toEqual(["defaults.board_cards_strict", "instances.a.board_cards_strict"]);
    expect(instanceFieldImpact("board_cards_strict")).toBe("now");
  });

  it("in a real FleetManager: read at each write; the tool's answers say what to do", async () => {
    const d = tmp();
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
    fm.scheduler = scheduler;
    closers.push(() => fm.taskBoardWaker?.stop(), () => scheduler.db.close());
    fm.fleetConfig = { defaults: {}, instances: { dev: { board_cards_strict: true } } };
    fm.attachTaskBoard(scheduler.db);
    const call = (args: Record<string, unknown>) => fm.handleTaskCrudHttp("dev", args);
    expect(await call({ action: "create", title: "Ping" })).toEqual({ error: expect.stringMatching(/^strict cards: open it as a board card/) });
    expect(await call({ action: "create", title: "Leaderboard", acceptance: ["resets on Monday"] })).toEqual({ error: expect.stringMatching(/^strict cards: a card needs its goal/) });
    expect(await call({ action: "create", title: "Leaderboard", description: "top 100", acceptance: ["resets on Monday"] })).toBe("ok M-1 Leaderboard [to do] @dev (v1)");
    await call({ action: "move", id: "M-1", to: "claimed" });
    expect(await call({ action: "move", id: "M-1", to: "done", result: "board.ts", reason: "later" })).toEqual({ error: expect.stringMatching(/^strict cards: 1 acceptance item\(s\) unchecked \(1\)/) });
    fm.fleetConfig = { defaults: {}, instances: { dev: {} } };            // a fleet.yaml edit: the next write
    expect(await call({ action: "move", id: "M-1", to: "done", result: "board.ts", reason: "later" })).toBe("ok M-1 in progress → done (v3)");
  }, 30_000);

  it("the instructions' task board section says so only for an agent held to it, with the board on", () => {
    const strict = buildFleetInstructions({ instanceName: "dev", workingDirectory: "/w", strictCards: true });
    const section = strict.slice(strict.indexOf("## Progress Tracking"), strict.indexOf("## Context Protection"));
    expect(section.trimEnd().endsWith(STRICT_CARDS_GUIDANCE)).toBe(true);
    expect(buildFleetInstructions({ instanceName: "dev", workingDirectory: "/w" })).not.toContain("Cards here are strict");
    expect(buildFleetInstructions({ instanceName: "dev", workingDirectory: "/w", strictCards: true, taskBoard: false })).not.toContain("Cards here are strict");
    expect(buildFleetInstructions({ instanceName: "dev", workingDirectory: "/w", strictCards: true, workflow: "## Mine\nmy rules" })).not.toContain("Cards here are strict");
  });
});
