/**
 * Which dashboard features an agent may use, on top of its tool profile (`tool_set`).
 *
 * `dashboard:` on an instance — and in `defaults:`, for every instance; the two merge key by key, so an instance sets
 * only what differs — switches whole features, the way a person thinks of them, instead of whole profiles:
 *
 * - `appearance`: its own look on the dashboard — theme, pictures, widgets, ambient, effects, mods it proposes;
 * - `task_board`: the task board (`task`, and `agend task …`);
 * - `web_settings`: Settings → Web appearance for the person (`get_web_settings`, `set_web_settings`).
 *
 * Unset is allowed: a fleet that switches nothing off works as before, and the profile still decides what an agent
 * has. `false` takes the feature's tools away whatever the profile carries: refused at the fleet's checks
 * (tool-permissions.ts's sinks, read at each call — no restart) and left out of the agent's tool menu from its next
 * start (AGEND_DASHBOARD_OFF, read by mcp-server). Like a profile, policy protection for the resolved identity, not
 * isolation between same-uid agents with a shell.
 */
export const DASHBOARD_FEATURES = ["appearance", "task_board", "web_settings"] as const;
export type DashboardFeature = typeof DASHBOARD_FEATURES[number];
/** As written in fleet.yaml: each feature true (allowed), false (switched off) or absent (allowed). */
export type DashboardAccess = Partial<Record<DashboardFeature, boolean>>;

/** Each feature's tools. Every appearance tool is the caller's own (no target); tests pin the lists to the profiles'. */
export const DASHBOARD_FEATURE_TOOLS: Readonly<Record<DashboardFeature, readonly string[]>> = {
  appearance: [
    "get_web_theme", "set_web_theme", "set_web_theme_asset", "reset_web_theme",
    "get_web_appearance", "preview_web_appearance",
    "set_web_widget", "remove_web_widget",
    "set_web_ambient", "clear_web_ambient",
    "export_web_mod", "propose_web_mod",
    "upload_web_effect", "list_web_effects", "preview_web_effect", "profile_web_effect", "apply_web_effect", "remove_web_effect", "delete_web_effect",
  ],
  task_board: ["task"],
  web_settings: ["get_web_settings", "set_web_settings"],
};

const FEATURE_OF: ReadonlyMap<string, DashboardFeature> = new Map(
  DASHBOARD_FEATURES.flatMap((f) => DASHBOARD_FEATURE_TOOLS[f].map((tool) => [tool, f] as const)),
);

/** The feature a tool belongs to, or null for a tool no switch governs. */
export function dashboardFeatureOf(tool: string): DashboardFeature | null {
  return FEATURE_OF.get(tool) ?? null;
}

const isFeature = (k: string): k is DashboardFeature => (DASHBOARD_FEATURES as readonly string[]).includes(k);

/** The features switched off (`false`) in an instance's `dashboard` as resolved; anything else allows. */
export function dashboardFeaturesOff(access: unknown): DashboardFeature[] {
  if (!access || typeof access !== "object" || Array.isArray(access)) return [];
  return DASHBOARD_FEATURES.filter((f) => (access as Record<string, unknown>)[f] === false);
}

/** The refusal for `tool` when its feature is switched off for this instance, else null. */
export function dashboardRefusal(access: unknown, tool: string): string | null {
  const feature = dashboardFeatureOf(tool);
  if (!feature || !dashboardFeaturesOff(access).includes(feature)) return null;
  return `${tool} is not available to this instance: the person switched its dashboard feature "${feature}" off (dashboard.${feature}: false). `
    + "Do not retry it; tell the person if you need it.";
}

/** A tool menu without the switched-off features' tools (mcp-server, from AGEND_DASHBOARD_OFF). */
export function withoutFeatures<T extends { name: string }>(tools: readonly T[], off: readonly DashboardFeature[]): T[] {
  if (!off.length) return [...tools];
  return tools.filter((t) => { const f = dashboardFeatureOf(t.name); return !f || !off.includes(f); });
}

/** AGEND_DASHBOARD_OFF as the daemon writes it ("appearance,task_board"); unknown names are ignored. */
export function featuresOffFromEnv(value: string | undefined): DashboardFeature[] {
  return [...new Set((value ?? "").split(",").map((s) => s.trim()).filter(isFeature))];
}

/** Why a `dashboard:` value is not one (fleet.yaml validation), or null: a mapping of known features to booleans. */
export function dashboardAccessProblem(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return `must be a mapping of ${DASHBOARD_FEATURES.join(", ")} to true or false`;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!isFeature(k)) return `unknown feature "${k}" (known: ${DASHBOARD_FEATURES.join(", ")})`;
    if (typeof v !== "boolean" && v !== null) return `${k} must be true or false`;
  }
  return null;
}

/** The features switched off in a fleet config for `name`: `defaults.dashboard` merged with the instance's own. */
export function dashboardFeaturesOffIn(fleet: unknown, name: string): DashboardFeature[] {
  const f = fleet && typeof fleet === "object" ? fleet as { defaults?: { dashboard?: unknown }; instances?: Record<string, { dashboard?: unknown } | undefined> } : {};
  const own = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
  return dashboardFeaturesOff({ ...own(f.defaults?.dashboard), ...own(f.instances?.[name]?.dashboard) });
}

/**
 * (a) An agent without the task board is not told to use it: the built-in workflow's task board section ("## Progress
 * Tracking", up to the next section) leaves its instructions, and a CLI agent's `agend-agent task …` lines theirs.
 */
export function withoutTaskBoardGuidance(workflow: string): string {
  return workflow.replace(/^## Progress Tracking\b[\s\S]*?(?=^## |(?![\s\S]))/m, "");
}
export function withoutTaskCommands(cli: string): string {
  return cli.split("\n").filter((line) => !/^\s*agend-agent task\b/.test(line)).join("\n");
}

/** (b) What an agent is told when the person switches the task board on for it (its tool list follows at once). */
export const TASK_BOARD_ON_NOTICE = "[Task board] The person switched the task board on for you: the `task` tool is in your tool list now. "
  + "Start with `task mine` (your work on the board); open a main task for multi-step work you are asked for, split it into sub tasks, "
  + "keep its state current, and finish a main task by moving it to review — only the person confirms it. "
  + "A later [Task board] notice is news on your cards: act on it with the `task` tool.";

/** (b) The task board went from switched off to allowed between two resolved configs of one instance. */
export function taskBoardSwitchedOn(before: unknown, after: unknown): boolean {
  return dashboardFeaturesOff(before).includes("task_board") && !dashboardFeaturesOff(after).includes("task_board");
}
