/**
 * The task board for agents that use it (the person's call, LiaoYiCheng 2026-10-22):
 * (c) at the fleet's first start with this release, a home that never used the board — and a new install — gets
 *     `defaults.dashboard.task_board: false` written into fleet.yaml (comments and the rest kept); one that used it
 *     (any card or task, the old `task` tool's too) keeps it; a fleet.yaml that already says something is left alone;
 *     once per home.
 * (a) an agent without the board is not told to use it: the built-in workflow's board section and a CLI agent's
 *     `agend-agent task` lines leave its instructions;
 * (b) switching the board on for an agent tells it, and its MCP menu follows fleet.yaml without a restart.
 *
 * Isolation: temp homes; fake timers for the menu's poll.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settleTaskBoardDefault, taskBoardUsed, TASK_BOARD_DEFAULT_MARKER } from "../src/task-board-default.js";
import { SchedulerDb } from "../src/scheduler/db.js";
import { loadFleetConfig } from "../src/config.js";
import { TASK_BOARD_ON_NOTICE, dashboardFeaturesOff, dashboardFeaturesOffIn, taskBoardSwitchedOn, withoutTaskBoardGuidance, withoutTaskCommands } from "../src/dashboard-permissions.js";
import { buildFleetInstructions } from "../src/instructions.js";
import { readDashboardOff, watchDashboardOff } from "../src/dashboard-live.js";

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const home = (yaml: string) => {
  const d = mkdtempSync(join(tmpdir(), "board-default-")); dirs.push(d);
  writeFileSync(join(d, "fleet.yaml"), yaml.replaceAll("<DIR>", d));
  return { dir: d, configPath: join(d, "fleet.yaml"), read: () => readFileSync(join(d, "fleet.yaml"), "utf8") };
};
const FLEET = "# my fleet\ndefaults:\n  backend: claude-code   # the usual\ninstances:\n  dev:\n    working_directory: <DIR>\n";

describe("(c) the board's default, once per home", () => {
  it("never used, and a new install: off, written where the person sees it — comments and the rest kept; once", () => {
    const h = home(FLEET);
    expect(taskBoardUsed(h.dir)).toBe(false);
    expect(settleTaskBoardDefault({ dataDir: h.dir, configPath: h.configPath })).toBe("off");
    const text = h.read();
    expect(text).toContain("# my fleet");
    expect(text).toMatch(/backend: claude-code +# the usual/);                     // as Settings saves it: the comment kept
    expect(dashboardFeaturesOff(loadFleetConfig(h.configPath).instances.dev!.dashboard)).toEqual(["task_board"]);
    expect(JSON.parse(readFileSync(join(h.dir, TASK_BOARD_DEFAULT_MARKER), "utf8")).decided).toBe("off");
    // The person switches it back on by removing the line: the next start leaves it alone.
    writeFileSync(h.configPath, FLEET.replaceAll("<DIR>", h.dir));
    expect(settleTaskBoardDefault({ dataDir: h.dir, configPath: h.configPath })).toBe("already");
    expect(h.read()).not.toContain("task_board");
  });

  it("used — a card on the board, or a task from the old task tool — stays on: nothing written", () => {
    const h = home(FLEET);
    const db = new SchedulerDb(join(h.dir, "scheduler.db"));
    db.board.createCards({ kind: "person", name: "Ann" }, { cards: [{ title: "Leaderboard" }] });
    db.close();
    expect(taskBoardUsed(h.dir)).toBe(true);
    expect(settleTaskBoardDefault({ dataDir: h.dir, configPath: h.configPath })).toBe("used");
    expect(h.read()).toBe(FLEET.replaceAll("<DIR>", h.dir));
    // A board that exists but holds nothing is not "used".
    const empty = home(FLEET);
    new SchedulerDb(join(empty.dir, "scheduler.db")).close();
    expect(settleTaskBoardDefault({ dataDir: empty.dir, configPath: empty.configPath })).toBe("off");
  });

  it("the person's own choice in fleet.yaml stands; a broken file is not written; an unreadable board keeps it on", () => {
    const own = home("defaults:\n  dashboard:\n    task_board: true\ninstances: {}\n");
    expect(settleTaskBoardDefault({ dataDir: own.dir, configPath: own.configPath })).toBe("explicit");
    expect(own.read()).toBe("defaults:\n  dashboard:\n    task_board: true\ninstances: {}\n");
    const broken = home("defaults: [unclosed\n");
    expect(settleTaskBoardDefault({ dataDir: broken.dir, configPath: broken.configPath })).toBe("skipped");
    expect(existsSync(join(broken.dir, TASK_BOARD_DEFAULT_MARKER))).toBe(false);
    const corrupt = home(FLEET);
    writeFileSync(join(corrupt.dir, "scheduler.db"), "not a database");
    expect(settleTaskBoardDefault({ dataDir: corrupt.dir, configPath: corrupt.configPath })).toBe("used");
    expect(corrupt.read()).not.toContain("task_board");
  });

  it("an empty defaults or dashboard becomes one; another feature's switch is kept", () => {
    for (const yaml of ["defaults:\ninstances: {}\n", "defaults:\n  dashboard:\ninstances: {}\n", "instances: {}\n", "defaults:\n  dashboard: { appearance: false }\ninstances: {}\n"]) {
      const h = home(yaml);
      expect(settleTaskBoardDefault({ dataDir: h.dir, configPath: h.configPath }), yaml).toBe("off");
      const cfg = loadFleetConfig(h.configPath);
      expect((cfg.defaults as any).dashboard.task_board, yaml).toBe(false);
      if (yaml.includes("appearance")) expect((cfg.defaults as any).dashboard.appearance).toBe(false);
    }
  });
});

describe("(a) an agent without the board is not told to use it", () => {
  const params = { instanceName: "dev", workingDirectory: "/w" };
  it("the built-in workflow loses its board section, and only that; a custom workflow is the person's", () => {
    const on = buildFleetInstructions(params), off = buildFleetInstructions({ ...params, taskBoard: false });
    expect(on).toContain("## Progress Tracking");
    expect(on).toContain("Task Board");
    expect(off).not.toContain("## Progress Tracking");
    expect(off).not.toMatch(/Task Board|`task` tool|task mine/);
    expect(off).toContain("## Context Protection");                      // the section after it stays
    expect(buildFleetInstructions({ ...params, taskBoard: false, workflow: "## Mine\nUse the task board." })).toContain("Use the task board.");
    expect(withoutTaskBoardGuidance("## A\na\n## Progress Tracking\nboard\n")).toBe("## A\na\n");
  });

  it("a CLI agent's quick reference loses the board's commands", () => {
    const cli = "agend-agent reply \"text\"\nagend-agent task mine # your work\nagend-agent task create \"t\"\nagend-agent decision list\n";
    expect(withoutTaskCommands(cli)).toBe("agend-agent reply \"text\"\nagend-agent decision list\n");
    const off = buildFleetInstructions({ ...params, taskBoard: false, cliInstructions: cli });
    expect(off).toContain("agend-agent decision list");
    expect(off).not.toContain("agend-agent task");
  });
});

describe("(b) switched on: the agent is told, and its tool menu follows without a restart", () => {
  it("off → on is the switch that tells; on → off, or on → on, does not", () => {
    expect(taskBoardSwitchedOn({ task_board: false }, {})).toBe(true);
    expect(taskBoardSwitchedOn({ task_board: false }, { task_board: true })).toBe(true);
    expect(taskBoardSwitchedOn({}, { task_board: false })).toBe(false);
    expect(taskBoardSwitchedOn({ appearance: false }, {})).toBe(false);
    expect(TASK_BOARD_ON_NOTICE).toMatch(/^\[Task board\].*`task mine`/);
    const source = readFileSync(new URL("../src/fleet-manager.ts", import.meta.url), "utf8");
    expect(source).toMatch(/if \(taskBoardSwitchedOn\(runtimeConfig\.dashboard, config\.dashboard\)\) \{\n\s+this\.admitTaskBoardNotice\(name, TASK_BOARD_ON_NOTICE,/);
  });

  it("the menu reads fleet.yaml as it is now (defaults and the agent's own), and says when it changes", () => {
    vi.useFakeTimers();
    const h = home("defaults:\n  dashboard: { task_board: false }\ninstances:\n  dev:\n    working_directory: <DIR>\n");
    expect(readDashboardOff(h.dir, "dev", [])).toEqual(["task_board"]);
    expect(dashboardFeaturesOffIn({ defaults: { dashboard: { task_board: false } }, instances: { dev: { dashboard: { task_board: true } } } }, "dev")).toEqual([]);
    const seen: string[][] = [];
    const stop = watchDashboardOff(h.dir, "dev", [], (off) => seen.push(off));
    vi.advanceTimersByTime(1500);
    expect(seen).toEqual([]);
    writeFileSync(h.configPath, h.read().replace("dashboard: { task_board: false }", "dashboard: { task_board: true }"));
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([[]]);
    stop();
    rmSync(h.configPath);
    expect(readDashboardOff(h.dir, "dev", ["appearance"])).toEqual(["appearance"]);    // unreadable: what the spawn said
  });
});
