/**
 * Who gets the task board by default (dashboard-permissions.ts's `task_board`), decided once per AgEnD home at the
 * fleet's first start with this release.
 *
 * - A fleet that has used the board — any card or task in scheduler.db, the old `task` tool's included — keeps it as it
 *   had it: nothing is written (unset allows).
 * - One that never has, and a new install, gets `defaults.dashboard.task_board: false` written into fleet.yaml: visible,
 *   and switched on in Settings → General → Defaults (or per agent) when the person wants it.
 * - A fleet.yaml that already says something about it is the person's choice: left as it is.
 *
 * The marker (`task-board-default.json` in the home) makes it once: a person who later removes the line, or empties the
 * board, is never overridden. Only startAll calls this — never a plain config read (a test, the CLI).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { isMap, parseDocument } from "yaml";
import { atomicWriteFileSync } from "./atomic-write.js";

export const TASK_BOARD_DEFAULT_MARKER = "task-board-default.json";
export type TaskBoardDefaultOutcome = "off" | "used" | "explicit" | "already" | "skipped";

/** Whether the board (or the old task list) holds anything: a card or task ever written. Unreadable: assume it was used. */
export function taskBoardUsed(dataDir: string): boolean {
  const path = join(dataDir, "scheduler.db");
  if (!existsSync(path)) return false;
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get();
      return !!table && !!db.prepare("SELECT 1 FROM tasks LIMIT 1").get();
    } finally { db.close(); }
  } catch { return true; }                                  // cannot tell: never take a board away
}

export function settleTaskBoardDefault(opts: { dataDir: string; configPath: string; now?: () => Date }): TaskBoardDefaultOutcome {
  const marker = join(opts.dataDir, TASK_BOARD_DEFAULT_MARKER);
  if (existsSync(marker)) return "already";
  if (!existsSync(opts.configPath)) return "skipped";           // no fleet yet: decided at the start that has one
  const source = readFileSync(opts.configPath, "utf-8");
  const doc = parseDocument(source, { keepSourceTokens: true });
  if (doc.errors.length) return "skipped";                       // the load reports it; nothing written into a broken file
  const mark = (decided: TaskBoardDefaultOutcome) => {
    atomicWriteFileSync(marker, JSON.stringify({ decided, at: (opts.now?.() ?? new Date()).toISOString() }) + "\n");
    return decided;
  };
  if (doc.hasIn(["defaults", "dashboard", "task_board"])) return mark("explicit");
  if (taskBoardUsed(opts.dataDir)) return mark("used");
  // An empty `defaults:` or `dashboard:` (null) is no collection to set into: it becomes one.
  if (!isMap(doc.get("defaults"))) doc.set("defaults", doc.createNode({ dashboard: { task_board: false } }));
  else if (!isMap(doc.getIn(["defaults", "dashboard"]))) doc.setIn(["defaults", "dashboard"], doc.createNode({ task_board: false }));
  else doc.setIn(["defaults", "dashboard", "task_board"], false);
  atomicWriteFileSync(opts.configPath, String(doc), { mode: statSync(opts.configPath).mode });
  return mark("off");
}
