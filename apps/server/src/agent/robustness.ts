export function dailyLimit(value: string | undefined) {
  if (value === undefined) return 2000;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 2000;
}

export function memoryTail(content: string, limit = 8000) {
  return content.length > limit ? "[Older content omitted. Consolidate this file; use memory_search for older facts.]\n" + content.slice(-limit) : content;
}

export function validateArgs(value: unknown, schema: Record<string, unknown>, path = "args"): void {
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required ?? []) as string[]) if (!(key in obj)) throw new Error(`${path}.${key} is required`);
    for (const [key, v] of Object.entries(obj)) {
      if (props[key]) validateArgs(v, props[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${path}.${key} is not allowed`);
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) throw new Error(`${path} has too many items`);
    for (const v of value) validateArgs(v, (schema.items ?? {}) as Record<string, unknown>, `${path}[]`);
  } else if (type && (typeof value !== type || (type === "number" && !Number.isFinite(value)))) {
    throw new Error(`${path} must be ${type}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`${path} is not an allowed value`);
}

export function retryable(error: unknown) {
  const e = error as { status?: number; name?: string };
  return (
    e?.status === 429 ||
    (e?.status !== undefined && e.status >= 500) ||
    ["APIConnectionError", "APIConnectionTimeoutError", "TypeError"].includes(e?.name ?? "")
  );
}

export function tipEligible(hatchedAt: Date | null, active: boolean, now = Date.now()) {
  return !active && !!hatchedAt && now - hatchedAt.getTime() >= 86400000;
}

export function reminderText(title: string) {
  return `⏰ Time to ${title
    .replace(/^remind(?:er)?(?: me)?(?: to)?\s*[:—-]?\s*/i, "")
    .replace(/[.!]+$/, "")
    .trim()}!`;
}

export function nextSchedule(intervalMinutes: number | null, previous: Date, now = new Date()) {
  return { lastRunAt: now, nextRunAt: intervalMinutes ? new Date(now.getTime() + intervalMinutes * 60000) : previous, enabled: !!intervalMinutes };
}

export const STEP_LIMITS: Record<string, number> = { generate_image: 2, spawn_subagents: 1, browser_task: 1 };

export function interruptedRun() {
  return { status: "failed", error: "Interrupted by server restart", endedAt: new Date() };
}

export function isLoopback(host: string) {
  return ["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase());
}

export function usageDay(now: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function nextLocalMidnight(now: Date, timezone: string) {
  const day = usageDay(now, timezone);
  let low = now.getTime();
  let high = low + 36 * 3600000;
  // Calendar-day boundaries, rather than adding 24h, also handle DST transitions.
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (usageDay(new Date(middle), timezone) === day) low = middle;
    else high = middle;
  }
  return new Date(high);
}

export function backgroundPauseState(resetsAt: string, day: string) {
  return {
    jobUpdate: { nextRunAt: new Date(new Date(resetsAt).getTime() + 60000) },
    noticeParts: [{ type: "background_usage_limit", day }],
  };
}

export function scheduledRunState(value: string | null) {
  const match = /^(run|retry):(\d+)(?::retry:(\d+))?$/.exec(value ?? "");
  return match ? { kind: match[1], runId: Number(match[2]), attempts: Number(match[3] ?? 0) } : null;
}

export function scheduledRunMarker(runId: number, previous: string | null) {
  const state = scheduledRunState(previous);
  return `run:${runId}:retry:${state?.kind === "retry" ? state.attempts : 0}`;
}

export function recoveryDecision(lastResult: string | null, acted: boolean) {
  const state = scheduledRunState(lastResult);
  if (!state || state.kind !== "run") return null;
  if (acted) return { retry: false, lastResult: "Interrupted after taking an action; not retried" };
  if (state.attempts >= 2) return { retry: false, lastResult: "Interrupted; catch-up attempt limit reached" };
  return { retry: true, lastResult: `retry:${state.runId}:retry:${state.attempts + 1}` };
}

export function skippedOccurrence(job: { title: string; intervalMinutes: number | null }, acted: boolean, timezone: string, now = new Date()) {
  const recurring = job.intervalMinutes !== null && job.intervalMinutes > 0;
  const nextRunAt = recurring ? new Date(now.getTime() + job.intervalMinutes! * 60000) : null;
  const reason = acted ? "after it may have taken an action" : "and it reached the catch-up attempt limit";
  const followUp = nextRunAt
    ? ` It will run again at ${nextRunAt.toLocaleString("en-US", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" })} (${timezone}).`
    : " Ask me if you want it done again.";
  return {
    update: {
      enabled: recurring,
      ...(nextRunAt ? { nextRunAt } : {}),
      lastResult: recurring ? "Skipped one run after a restart" : "Not retried after a restart",
    },
    message: `A restart interrupted “${job.title}” ${reason}, so I skipped that run.${followUp}`,
  };
}

export function hasActionEvidence(
  approvals: { status: string; actionClass: string }[],
  activity: { kind: string; details: Record<string, unknown> }[],
  toolNames: string[],
) {
  const actions = ["send", "submit", "purchase"];
  return (
    approvals.some((a) => a.status === "allowed" && actions.includes(a.actionClass)) ||
    activity.some((a) => actions.includes(a.kind) || actions.includes(String(a.details.actionClass ?? ""))) ||
    toolNames.some(
      (name) =>
        /(?:send|submit|purchase|checkout|pay)/i.test(name) ||
        name.startsWith("browser") ||
        ["api_request", "connectors", "google", "windmill", "mcp"].includes(name),
    )
  );
}
