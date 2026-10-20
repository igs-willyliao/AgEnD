/**
 * The task board's web routes (/ui/tasks/board, /ui/tasks/cards…, /ui/tasks/projects…; design: docs/design/task-board.md)
 * through the real web handler, with a real FleetManager (no fleet; nothing spawns) and a real scheduler database.
 *
 *   1. A signed-in person runs a card from opening to confirming; reads return card numbers.
 *   2. The person is a signed-in session only: the header token (the CLI's, a script's — any agent here can read the
 *      token file) cannot write to the board, and on the old /ui/tasks routes it is held to an instance's rules, so it
 *      never confirms work waiting for the person.
 *   3. Refusals: a stale version is 409 with the board's code, a missing card 404, an unknown field 400.
 *   4. The public link carries the board's routes (the person works the board remotely), and nothing else under them.
 *
 * The rig is #1827's (tests/web-display-name-1827.test.ts): the real /dashboard → DM → /auth/login path signs in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No inspector"); } } }));
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { FleetManager } from "../src/fleet-manager.js";
import { handleAuthRequest, type AuthApiContext } from "../src/auth-api.js";
import { handleWebRequest } from "../src/web-api.js";
import { csrfTokenFor } from "../src/web-session.js";
import { setLocale } from "../src/locale.js";
import { SchedulerDb } from "../src/scheduler/db.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";

const LOCAL_HOST = "127.0.0.1:19280", LOCAL_ORIGIN = `http://${LOCAL_HOST}`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const CODE = /[A-Z0-9]{4}-[A-Z0-9]{4}/;
const TOKEN = "c".repeat(48);

let mono = 0;
const rigs: Array<{ dir: string; s: any; db: SchedulerDb }> = [];
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }

/** A real FleetManager with no fleet: one Telegram bot "owner", General "T0", admin "admin"; a real scheduler database. */
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "agend-task-board-"));
  const fm = new FleetManager(dir), s = fm as any;
  const adapter = { id: "owner", type: "telegram", sendText: vi.fn(async (chat: string, _text: string, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "safe" })),
    notifyAlert: vi.fn(async (chat: string, _alert: any, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "menu" })),
    sendDirect: vi.fn(async (user: string, _text: string, _opts?: any) => ({ chatId: user, messageId: "dm" })),
    editMessageRemoveButtons: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  const owner = { id: "owner", type: "telegram", group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin"] } };
  fm.fleetConfig = { defaults: {}, channel: owner, channels: [owner], health_port: 19280, instances: {
    general: { working_directory: dir, general_topic: true, topic_id: "T0", channel_id: "owner" },
  } } as never;
  fm.routing.rebuild(fm.fleetConfig!); s.adapters.set("owner", adapter); s.adapter = adapter;
  s.worlds.set("owner", { adapter, groupId: "G", channelConfig: owner, accessManager: { isAllowed: () => true }, stop: async () => {} });
  s.classicChannels = { isClassicChannel: () => false, hasChannel: () => false, getAll: () => [], getChannelIdByInstance: () => undefined, isCollab: () => false };
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); s.initializeWebSessions();
  const db = new SchedulerDb(join(dir, "scheduler.db"));
  s.scheduler = { db };

  /** The real /dashboard menu, then "local": the code the owner got by DM. */
  async function dashboardCode(user = "admin"): Promise<string> {
    adapter.notifyAlert.mockClear();
    await s.topicCommands.handleGeneralCommand({ source: "telegram", adapterId: "owner", chatId: "G", threadId: "T0", userId: user, username: user, text: "/dashboard", messageId: "in", timestamp: new Date() });
    const e = [...s.pendingNonceButtons.values()].find((x: any) => x.chatId === "G" && !x.consumed) as any;
    const before = adapter.sendDirect.mock.calls.length;
    await s.dispatchAdapterCallback({ callbackData: `dashboard:${e.nonce}:local`, chatId: e.chatId, threadId: e.threadId, messageId: e.messageId, userId: user, ack: vi.fn() }, "owner", adapter);
    await flush();
    const dm = adapter.sendDirect.mock.calls.slice(before).map(c => String(c[1])).find(text => CODE.test(text));
    if (!dm) throw new Error("no code by DM");
    return CODE.exec(dm)![0];
  }

  /** Sign in as `user` through the real auth handler: the session's cookie and id. */
  async function signIn(user = "admin"): Promise<Who> {
    const code = await dashboardCode(user);
    const headers: Record<string, string> = { host: LOCAL_HOST, "user-agent": UA, origin: LOCAL_ORIGIN, "content-type": "application/json" };
    const req = Object.assign(new EventEmitter(), { method: "POST", url: "/auth/login", headers, destroy: vi.fn() });
    let status = 0; const out: Record<string, any> = {};
    const res = { destroyed: false, headersSent: false, setHeader: (k: string, v: any) => { out[k] = v; }, writeHead: (c: number, h = {}) => { status = c; Object.assign(out, h); }, end: () => {}, destroy: vi.fn() };
    expect(handleAuthRequest(req as never, res as never, new URL("/auth/login", LOCAL_ORIGIN), fm as unknown as AuthApiContext)).toBe(true);
    req.emit("data", Buffer.from(JSON.stringify({ code }))); req.emit("end");
    await flush(); await vi.advanceTimersByTimeAsync(0); await flush();
    expect(status).toBe(200);
    const c = ([] as string[]).concat(out["Set-Cookie"] ?? []).find((x) => /^(__Host-)?agend_session=/.test(x))!.split(";")[0]!;
    return { cookie: c, sessionId: c.split("=")[1]! };
  }

  const h = { dir, fm, s, db, signIn }; rigs.push(h); return h;
}
type Rig = ReturnType<typeof rig>;
type Who = { cookie?: string; sessionId?: string; token?: string };

/** One request through the real web routes, as a page of that session (cookie, same origin, CSRF) or the CLI token. */
async function web(h: Rig, path: string, method: string, who: Who, body?: unknown) {
  const headers: Record<string, string> = { host: LOCAL_HOST, origin: LOCAL_ORIGIN, "user-agent": UA, ...(who.cookie ? { cookie: who.cookie } : {}),
    ...(who.sessionId ? { "x-agend-csrf": csrfTokenFor(who.sessionId) } : {}), ...(who.token ? { "x-agend-token": who.token } : {}),
    ...(method === "POST" ? { "content-type": "application/json" } : {}) };
  const req = Object.assign(new EventEmitter(), { method, url: path, headers, destroy: vi.fn(), socket: { destroy() {}, remoteAddress: "127.0.0.1" } });
  let status = 0, text = "";
  const res = Object.assign(new EventEmitter(), { destroyed: false, headersSent: false, setHeader() {}, writeHead: (c: number) => { status = c; }, end: (t = "") => { text = t; }, write() { return true; }, destroy: vi.fn() });
  expect(handleWebRequest(req as never, res as never, new URL(path, LOCAL_ORIGIN), h.fm as never)).toBe(true);
  if (method === "POST") { req.emit("data", Buffer.from(JSON.stringify(body ?? {}))); req.emit("end"); }
  for (let n = 0; n < 6; n++) { await flush(); await vi.advanceTimersByTimeAsync(0); }
  return { status, json: () => (text ? JSON.parse(text) : null) };
}

beforeEach(() => { setLocale("en"); vi.useFakeTimers(); mono = 0; vi.spyOn(performance, "now").mockImplementation(() => mono); });
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const h of rigs.splice(0)) {
    try { h.s.replyButtonsCtl?.stop(); h.s.replyButtonsStore?.close(); } catch { /* none */ }
    try { h.db.close(); } catch { /* closed */ }
    rmSync(h.dir, { recursive: true, force: true });
  }
});

describe("1. a signed-in person runs a card from opening to confirming", () => {
  it("project, main task, sub task; the instance finishes the sub task; the person confirms the main task", async () => {
    const h = rig();
    const me = await h.signIn("admin");
    const p = await web(h, "/ui/tasks/projects", "POST", me, { name: "Game", description: "the fish game" });
    expect(p.status).toBe(200);
    const projectId = p.json().project.id;
    const m = await web(h, "/ui/tasks/cards", "POST", me, { kind: "main", project: projectId, title: "Build the leaderboard", assignee: "dev-a", acceptance: ["top 100"] });
    expect(m.status).toBe(200);
    expect(m.json().card).toMatchObject({ id: "M-1", kind: "main", projectId, assignee: "dev-a", needsReview: true, status: "open", createdBy: "admin" });
    const s = await web(h, "/ui/tasks/cards", "POST", me, { parent: "M-1", title: "Sort the scores", assignee: "dev-a" });
    expect(s.json().card).toMatchObject({ id: "S-1", parentId: "M-1", projectId });

    // The instance works through its task tool (the same rows, the same rules).
    const dev = { kind: "instance" as const, name: "dev-a" };
    const sub = h.db.board.getCard("S-1");
    h.db.claimTask(sub.uuid, "dev-a");
    h.db.completeTask(sub.uuid, "sorted with a heap", dev);

    const board = (await web(h, "/ui/tasks/board", "GET", me)).json();
    expect(board.projects.map((x: any) => x.name)).toEqual(["Game"]);
    expect(board.stats[String(projectId)]).toMatchObject({ mains: 1, waiting: 1, percent: 100, units: { total: 1, done: 1 } });
    expect(board.cards.find((c: any) => c.id === "M-1")).toMatchObject({ status: "review", progress: { total: 1, done: 1 } });

    const confirm = await web(h, "/ui/tasks/cards/M-1/move", "POST", me, { to: "done", version: h.db.board.getCard("M-1").version });
    expect(confirm.status).toBe(200);
    expect(confirm.json().card.status).toBe("done");
    const detail = (await web(h, "/ui/tasks/cards/m1", "GET", me)).json();
    expect(detail.card.id).toBe("M-1");
    expect(detail.children.map((c: any) => c.id)).toEqual(["S-1"]);
    expect(detail.history.map((e: any) => [e.actor, e.actorKind, e.type]).slice(-1)).toEqual([["admin", "person", "moved"]]);
  });

  it("comments, edits, reorder and search go through the same routes", async () => {
    const h = rig();
    const me = await h.signIn("admin");
    await web(h, "/ui/tasks/cards", "POST", me, { title: "First" });
    await web(h, "/ui/tasks/cards", "POST", me, { title: "Second" });
    expect((await web(h, "/ui/tasks/cards/M-1", "POST", me, { comment: "use the new table", goal: "faster reads", version: 1 })).json().card)
      .toMatchObject({ goal: "faster reads", version: 2, commentCount: 1 });
    expect((await web(h, "/ui/tasks/cards/M-1/reorder", "POST", me, { after: "M-2" })).status).toBe(200);
    expect((await web(h, "/ui/tasks/board", "GET", me)).json().cards.map((c: any) => c.id)).toEqual(["M-2", "M-1"]);
    const found = (await web(h, "/ui/tasks/search?q=new%20table", "GET", me)).json().results;
    expect(found.map((r: any) => [r.card.id, r.match.field])).toEqual([["M-1", "comment"]]);
  });
});

describe("2. the person is a signed-in session only", () => {
  it("the header token cannot write to the board's routes", async () => {
    const h = rig();
    const token = { token: TOKEN };
    expect((await web(h, "/ui/tasks/board", "GET", token)).status).toBe(200);
    const r = await web(h, "/ui/tasks/projects", "POST", token, { name: "Sneaky" });
    expect(r.status).toBe(403);
    expect(r.json()).toEqual({ error: "The task board takes changes from a signed-in dashboard", code: "forbidden" });
    expect(h.db.board.listProjects()).toEqual([]);
  });

  it("on the old /ui/tasks routes the token is held to an instance's rules: it never confirms work that waits for the person", async () => {
    const h = rig();
    const me = await h.signIn("admin");
    await web(h, "/ui/tasks/cards", "POST", me, { title: "Ship it", assignee: "dev-a" });
    const card = h.db.board.getCard("M-1");
    const token = { token: TOKEN };
    // Not the person, and not its assignee: the token finishes nothing.
    const take = await web(h, `/ui/tasks/${card.uuid}`, "POST", token, { action: "complete", result: "done, trust me" });
    expect(take.status).toBe(400);
    expect(take.json().error).toMatch(/assigned to dev-a/);
    // Its assignee finishes it: it waits for the person.
    const dev = { kind: "instance" as const, name: "dev-a" };
    expect(h.db.completeTask(card.uuid, "shipped", dev).status).toBe("review");
    const r = await web(h, `/ui/tasks/${card.uuid}`, "POST", token, { action: "update", status: "done" });
    expect(r.status).toBe(400);
    expect(r.json().error).toMatch(/waiting for the person's confirmation/);
    expect(h.db.board.getCard("M-1").status).toBe("review");
    // The signed-in person can.
    expect((await web(h, `/ui/tasks/${card.uuid}`, "POST", me, { action: "update", status: "done" })).json().status).toBe("done");
    expect(h.db.board.events(card.uuid).filter((e) => e.type === "moved").map((e) => [e.actor, e.actorKind, e.data.to])).toEqual([
      ["dev-a", "instance", "claimed"], ["dev-a", "instance", "review"], ["admin", "person", "done"],
    ]);
  });

  it("an instance's task list shows its cards waiting for the person, and takes their card numbers", async () => {
    const h = rig();
    const me = await h.signIn("admin");
    await web(h, "/ui/tasks/cards", "POST", me, { title: "Ship it", assignee: "dev-a" });
    const card = h.db.board.getCard("M-1");
    h.db.completeTask(card.uuid, "shipped", { kind: "instance", name: "dev-a" });
    const list = await h.fm.handleTaskCrudHttp("dev-a", { action: "list" }) as Array<{ id: string; status: string }>;
    expect(list.map((t) => [t.id, t.status])).toEqual([[card.uuid, "review"]]);
    expect(await h.fm.handleTaskCrudHttp("dev-a", { action: "get", id: "M-1" })).toMatchObject({ id: card.uuid, code: "M-1", status: "review" });
  });
});

describe("3. refusals", () => {
  it("a stale version is 409 with the board's code; a missing card 404; an unknown field 400", async () => {
    const h = rig();
    const me = await h.signIn("admin");
    await web(h, "/ui/tasks/cards", "POST", me, { title: "One" });
    await web(h, "/ui/tasks/cards/M-1", "POST", me, { goal: "first", version: 1 });
    const stale = await web(h, "/ui/tasks/cards/M-1", "POST", me, { goal: "second", version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.json()).toMatchObject({ code: "conflict" });
    expect(stale.json().error).toMatch(/M-1 changed meanwhile \(you have v1, it is v2, last changed by admin\)/);
    expect((await web(h, "/ui/tasks/cards/M-9", "GET", me)).status).toBe(404);
    expect((await web(h, "/ui/tasks/cards/M-9/move", "POST", me, { to: "done" })).status).toBe(404);
    expect((await web(h, "/ui/tasks/cards", "POST", me, { title: "x", internal: true })).status).toBe(400);
    expect((await web(h, "/ui/tasks/cards/M-1/move", "POST", me, { to: "finished" })).status).toBe(400);
  });
});

describe("4. the public link carries the board", () => {
  it("its reads and writes, exactly", () => {
    for (const [method, path] of [
      ["GET", "/ui/tasks/board"], ["GET", "/ui/tasks/search"], ["GET", "/ui/tasks/cards/M-3"],
      ["POST", "/ui/tasks/cards"], ["POST", "/ui/tasks/cards/M-3"], ["POST", "/ui/tasks/cards/M-3/move"], ["POST", "/ui/tasks/cards/S-1/reorder"],
      ["POST", "/ui/tasks/projects"], ["POST", "/ui/tasks/projects/2"],
    ] as const) expect(isPublicWebRoute(method, path), `${method} ${path}`).toBe(true);
    for (const [method, path] of [
      ["DELETE", "/ui/tasks/cards/M-3"], ["POST", "/ui/tasks/cards/M-3/delete"], ["POST", "/ui/tasks/projects/x"],
      ["GET", "/ui/tasks/cards/M-3/move"], ["POST", "/ui/tasks/cards/M-3/move/again"],
    ] as const) expect(isPublicWebRoute(method, path), `${method} ${path}`).toBe(false);
  });
});
