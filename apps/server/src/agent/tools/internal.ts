import { and, desc, eq, sql } from "drizzle-orm";
import { agentsTable, artifactsTable, db, documentsTable, goalsTable, ideasTable, scheduledTasksTable, spacesTable, trackingItemsTable, type DocBlock, type DocComment, type PlanStep } from "@amuse/db";
import { publish } from "../bus";
import { makeBlockId, markdownToBlocks, slugifyDoc, syncDocToWorkspace } from "../docs";
import { check, hasUntrustedRead } from "../sentinel";
import { appendFile, deleteFile, listFiles, readFile, today, writeFile } from "../workspace";
import { obj, str, num, type ToolDef } from "./types";

export const isSensitiveFile = (path: string) => /^(SOUL|HEARTBEAT|BOOTSTRAP|AGENTS|IDENTITY)\.md$/i.test(path.replace(/^\.\//, ""));
export const isPrivateFile = (path: string) => /^(MEMORY\.md|USER\.md|memory\/)/i.test(path.replace(/^\.\//, ""));
export function persistenceNeedsApproval(untrusted: boolean, tool: string, path = "", htmlChanged = false): boolean {
  return (
    untrusted &&
    (["memory_save", "memory_forget", "ideas_add"].includes(tool) ||
      (["write_file", "delete_file"].includes(tool) && isPrivateFile(path)) ||
      (tool === "space_update" && htmlChanged))
  );
}
export function forgetExactLine(content: string, line: string) {
  const lines = content.split("\n");
  const removed = line.trim() ? lines.filter((l) => l === line) : [];
  return { content: lines.filter((l) => !removed.includes(l)).join("\n"), removed };
}
export function schedulePolicy(trigger: string, active: number, interval?: number | null): string | null {
  if (["schedule", "space"].includes(trigger)) return "Background runs cannot create schedules.";
  if (active >= 20) return "At most 20 active schedules are allowed. Cancel an existing schedule first.";
  if (interval != null && (!Number.isFinite(interval) || interval < 15)) return "Repeat intervals must be at least 15 minutes.";
  return null;
}
async function insertSchedule(trigger: string, values: typeof scheduledTasksTable.$inferInsert) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${values.userId}))`);
    const active = await tx
      .select({ id: scheduledTasksTable.id })
      .from(scheduledTasksTable)
      .where(and(eq(scheduledTasksTable.userId, values.userId), eq(scheduledTasksTable.enabled, true)));
    const error = schedulePolicy(trigger, active.length, values.intervalMinutes);
    if (error) throw new Error(error);
    const [row] = await tx.insert(scheduledTasksTable).values(values).returning();
    return row!;
  });
}
const rid = () => Math.random().toString(36).slice(2, 9);

export const memoryTools: ToolDef[] = [
  {
    name: "memory_save",
    skill: "Memory",
    status: "Is updating memory",
    description:
      "Save something durable you learned. target 'user' = stable fact/preference about the person (USER.md); 'memory' = long-term note or decision (MEMORY.md); 'daily' = today's log.",
    parameters: obj({ target: { type: "string", enum: ["user", "memory", "daily"] }, note: str("One concise line") }, ["target", "note"]),
    async run({ target, note }, ctx) {
      await ctx.setStatus("Is updating memory");
      const path = target === "user" ? "USER.md" : target === "memory" ? "MEMORY.md" : `memory/${today(ctx.tz)}.md`;
      if (
        persistenceNeedsApproval(hasUntrustedRead(ctx.runId), "memory_save") &&
        (await check({
          ...ctx,
          toolName: "memory_save",
          actionClass: "write",
          target: path,
          purpose: `Save memory after reading untrusted content: ${note}`,
          details: { note },
          forceAsk: true,
        })) === "deny"
      )
        return { error: "The person denied saving this memory." };
      if (path === "USER.md") {
        const cur = (await readFile(ctx.userId, path)) ?? "";
        if (cur.includes("(Nothing yet.")) await writeFile(ctx.userId, path, "# About my person\n\n");
      }
      await appendFile(ctx.userId, path, `- ${note}`);
      await ctx.activity("memory", `Remembered: ${note}`, { path }, "Memory");
      publish(ctx.userId, { type: "refresh", what: "files" });
      return { saved: true, path };
    },
  },
  {
    name: "memory_forget",
    skill: "Memory",
    status: "Is updating memory",
    description:
      "Forget an exact full line the person asked to remove from USER.md, MEMORY.md and daily memory files. Read the file first and pass the line verbatim; tell the person which lines were removed.",
    parameters: obj({ about: str("Exact full line to remove, including any bullet prefix") }, ["about"]),
    async run({ about }, ctx) {
      await ctx.setStatus("Is updating memory");
      if (
        persistenceNeedsApproval(hasUntrustedRead(ctx.runId), "memory_forget") &&
        (await check({
          ...ctx,
          toolName: "memory_forget",
          actionClass: "write",
          purpose: `Forget memory after reading untrusted content: ${about}`,
          details: { line: about },
          forceAsk: true,
        })) === "deny"
      )
        return { error: "The person denied forgetting this memory." };
      const files = (await listFiles(ctx.userId)).filter((f) => f.path === "USER.md" || f.path === "MEMORY.md" || f.path.startsWith("memory/"));
      const removed: { path: string; line: string }[] = [];
      for (const f of files) {
        const c = (await readFile(ctx.userId, f.path)) ?? "";
        const result = forgetExactLine(c, String(about));
        if (result.removed.length) {
          removed.push(...result.removed.map((line) => ({ path: f.path, line })));
          await writeFile(ctx.userId, f.path, result.content);
        }
      }
      await ctx.activity("memory", `Forgot exact line (${removed.length} notes removed)`, {}, "Memory");
      publish(ctx.userId, { type: "refresh", what: "files" });
      return { removed };
    },
  },
  {
    name: "read_file",
    skill: "Files",
    status: "Reading files",
    subagentSafe: true,
    description: "Read a file from your workspace (e.g. SOUL.md, USER.md, files/notes.md, skills/x/tool.js).",
    parameters: obj({ path: str("Workspace path") }, ["path"]),
    async run({ path }, ctx) {
      const c = await readFile(ctx.userId, path);
      return c === null ? { error: "No such file", files: (await listFiles(ctx.userId)).map((f) => f.path) } : { path, content: c.slice(0, 20000) };
    },
  },
  {
    name: "write_file",
    skill: "Files",
    status: "Writing files",
    description: "Create or overwrite a workspace file. Changes to core instruction files require explicit approval.",
    parameters: obj({ path: str("Workspace path"), content: str("Full file content") }, ["path", "content"]),
    async run({ path, content }, ctx) {
      const asks =
        (isSensitiveFile(path) && !(path === "BOOTSTRAP.md" && !content.trim())) || persistenceNeedsApproval(hasUntrustedRead(ctx.runId), "write_file", path);
      if (
        (await check({
          ...ctx,
          toolName: "write_file",
          actionClass: asks ? "write" : "internal",
          target: path,
          purpose: `Write ${path}`,
          details: { content },
          forceAsk: asks,
        })) === "deny"
      )
        return { error: "The person denied writing this file." };
      await writeFile(ctx.userId, path, content);
      if (path === "BOOTSTRAP.md" && !content.trim()) await deleteFile(ctx.userId, path);
      await ctx.activity("tool", `Updated ${path}`, {}, "Files");
      publish(ctx.userId, { type: "refresh", what: "files" });
      return { ok: true };
    },
  },
  {
    name: "delete_file",
    skill: "Files",
    status: "Tidying files",
    description: "Delete a workspace file (e.g. BOOTSTRAP.md after first-run).",
    parameters: obj({ path: str("Workspace path") }, ["path"]),
    async run({ path }, ctx) {
      if (
        persistenceNeedsApproval(hasUntrustedRead(ctx.runId), "delete_file", path) &&
        (await check({ ...ctx, toolName: "delete_file", actionClass: "write", target: path, purpose: `Delete private memory ${path}`, forceAsk: true })) ===
          "deny"
      )
        return { error: "The person denied deleting this memory." };
      if (["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"].includes(path)) return { error: "Core files can't be deleted." };
      // Removing the first-run script is the normal end of onboarding and can't add instructions.
      if (
        isSensitiveFile(path) &&
        path !== "BOOTSTRAP.md" &&
        (await check({ ...ctx, toolName: "delete_file", actionClass: "write", target: path, purpose: `Delete ${path}`, forceAsk: true })) === "deny"
      )
        return { error: "The person denied deleting this file." };
      await deleteFile(ctx.userId, path);
      publish(ctx.userId, { type: "refresh", what: "files" });
      return { ok: true };
    },
  },
  {
    name: "set_identity",
    skill: "Personality",
    status: "Is updating memory",
    description: "Change your own name, vibe or emoji when the person asks.",
    parameters: obj({ name: str("New name"), vibe: str("One-line vibe"), emoji: str("Single emoji") }),
    async run({ name, vibe, emoji }, ctx) {
      if (
        (await check({
          ...ctx,
          toolName: "set_identity",
          actionClass: "write",
          target: "IDENTITY.md",
          purpose: "Change identity",
          details: { name, vibe, emoji },
          forceAsk: true,
        })) === "deny"
      )
        return { error: "The person denied changing identity." };
      const [a] = await db.select().from(agentsTable).where(eq(agentsTable.userId, ctx.userId));
      const next = { name: name ?? a?.name ?? "Amuse", vibe: vibe ?? a?.vibe ?? "", emoji: emoji ?? a?.emoji ?? "🪺" };
      await db.update(agentsTable).set(next).where(eq(agentsTable.userId, ctx.userId));
      await writeFile(ctx.userId, "IDENTITY.md", `# Identity\n\n- Name: ${next.name}\n- Vibe: ${next.vibe}\n- Emoji: ${next.emoji}\n`);
      publish(ctx.userId, { type: "refresh", what: "agent" });
      await ctx.activity("tool", `Changed identity to ${next.name}`, next, "Personality");
      return { ok: true, ...next };
    },
  },
];

export const planningTools: ToolDef[] = [
  {
    name: "goal_create",
    skill: "Goals",
    status: "Making a plan",
    description: "Create a goal with a concrete action plan (4-8 steps). Use when the person states an ambition or multi-week project.",
    parameters: obj(
      {
        title: str("Short goal title"),
        description: str("Why it matters / target"),
        emoji: str("Emoji"),
        steps: { type: "array", items: { type: "string" }, description: "Ordered plan steps" },
      },
      ["title", "steps"],
    ),
    async run({ title, description, emoji, steps }, ctx) {
      await ctx.setStatus("Making a plan");
      const plan: PlanStep[] = (steps as string[]).map((s) => ({ id: rid(), title: s, done: false }));
      const [g] = await db
        .insert(goalsTable)
        .values({ userId: ctx.userId, title, description: description ?? "", emoji: emoji ?? "🎯", plan })
        .returning();
      await ctx.activity("skill", `Created goal "${title}" with ${plan.length} steps`, { goalId: g!.id }, "Goals");
      ctx.addParts([{ type: "goal", goalId: g!.id, title }]);
      publish(ctx.userId, { type: "refresh", what: "goals" });
      return { goal_id: g!.id, plan };
    },
  },
  {
    name: "goal_update",
    skill: "Goals",
    status: "Updating your goals",
    description: "Update a goal: mark steps done, add steps, set status (active|done|paused) or a progress note.",
    parameters: obj(
      {
        goal_id: num("Goal id"),
        complete_step_ids: { type: "array", items: { type: "string" } },
        add_steps: { type: "array", items: { type: "string" } },
        status: { type: "string", enum: ["active", "done", "paused"] },
        progress_note: str("Short progress note"),
      },
      ["goal_id"],
    ),
    async run(a, ctx) {
      const [g] = await db
        .select()
        .from(goalsTable)
        .where(and(eq(goalsTable.id, a.goal_id), eq(goalsTable.userId, ctx.userId)));
      if (!g) return { error: "No such goal" };
      let plan = g.plan.map((s) => (a.complete_step_ids?.includes(s.id) ? { ...s, done: true } : s));
      if (a.add_steps?.length) plan = plan.concat(a.add_steps.map((t: string) => ({ id: rid(), title: t, done: false })));
      await db
        .update(goalsTable)
        .set({ plan, status: a.status ?? g.status, progressNote: a.progress_note ?? g.progressNote, updatedAt: new Date() })
        .where(eq(goalsTable.id, g.id));
      await ctx.activity("skill", `Updated goal "${g.title}"`, {}, "Goals");
      publish(ctx.userId, { type: "refresh", what: "goals" });
      return { ok: true, plan };
    },
  },
  {
    name: "goals_list",
    skill: "Goals",
    status: "Checking your goals",
    subagentSafe: true,
    description: "List the person's goals and plans.",
    parameters: obj({}),
    async run(_a, ctx) {
      return { goals: await db.select().from(goalsTable).where(eq(goalsTable.userId, ctx.userId)) };
    },
  },
  {
    name: "ideas_add",
    skill: "Ideas",
    status: "Thinking of ideas",
    description: "Add personalised ideas to the Ideas tab: concrete things you could do for the person, each with a ready-to-run prompt.",
    parameters: obj(
      {
        ideas: {
          type: "array",
          items: obj(
            {
              title: str("Short title"),
              body: str("One sentence why"),
              prompt: str("The exact request to run if they tap it"),
              category: str("e.g. money, health, home, work, fun"),
              emoji: str("Emoji"),
            },
            ["title", "body", "prompt"],
          ),
        },
      },
      ["ideas"],
    ),
    async run({ ideas }, ctx) {
      const asks = persistenceNeedsApproval(hasUntrustedRead(ctx.runId), "ideas_add");
      if (
        (await check({ ...ctx, toolName: "ideas_add", actionClass: asks ? "write" : "internal", forceAsk: asks, purpose: "Add ideas", details: { ideas } })) ===
        "deny"
      )
        return { error: "Denied" };
      const rows = await db
        .insert(ideasTable)
        .values(
          (ideas as any[]).slice(0, 8).map((i) => ({
            userId: ctx.userId,
            title: i.title,
            body: i.body ?? "",
            prompt: i.prompt,
            category: i.category ?? "general",
            emoji: i.emoji ?? "💡",
            source: "agent",
          })),
        )
        .returning();
      await ctx.activity("skill", `Added ${rows.length} ideas`, {}, "Ideas");
      publish(ctx.userId, { type: "refresh", what: "ideas" });
      return { added: rows.length };
    },
  },
  {
    name: "schedule_task",
    skill: "Scheduling",
    status: "Scheduling a task",
    description:
      "Schedule work that runs later in the background: a reminder, a recurring check/monitor, or a follow-up. Give either in_minutes or at_iso for the first run, and every_minutes for repeats. The prompt is what you will be asked to do at that time.",
    parameters: obj(
      {
        title: str("Short title shown in Upcoming"),
        kind: { type: "string", enum: ["reminder", "monitor", "task"] },
        prompt: str("Instruction for your future self"),
        in_minutes: num("Minutes from now for the first run"),
        at_iso: str("ISO datetime for the first run"),
        every_minutes: num("Repeat interval in minutes (omit for one-off)"),
        goal_id: num("Related goal id"),
      },
      ["title", "kind", "prompt"],
    ),
    async run(a, ctx) {
      const first = a.at_iso ? new Date(a.at_iso) : new Date(Date.now() + (a.in_minutes ?? 1) * 60000);
      if (isNaN(first.getTime())) return { error: "Bad time" };
      const every = a.every_minutes == null ? null : Math.round(a.every_minutes);
      const error = schedulePolicy(ctx.trigger, 0, every);
      if (error) return { error };
      // A one-off reminder only posts a message; anything that later runs the agent asks first.
      const runsAgent = a.kind !== "reminder" || every != null;
      if (
        runsAgent &&
        (await check({
          ...ctx,
          toolName: "schedule_task",
          actionClass: "write",
          purpose: `Schedule "${a.title}"`,
          details: { prompt: a.prompt, first: first.toISOString(), every },
          forceAsk: true,
        })) === "deny"
      )
        return { error: "The person denied this schedule." };
      const t = await insertSchedule(ctx.trigger, {
        userId: ctx.userId,
        kind: a.kind,
        title: a.title,
        prompt: a.prompt,
        nextRunAt: first,
        intervalMinutes: every,
        goalId: a.goal_id ?? null,
      });
      await ctx.activity(
        "schedule",
        `Scheduled "${a.title}" for ${first.toLocaleString("en-US", { timeZone: ctx.tz })}${every ? ` (every ${every} min)` : ""}`,
        { taskId: t!.id },
        "Scheduling",
      );
      ctx.addParts([{ type: "scheduled", taskId: t!.id, title: a.title, nextRunAt: first.toISOString(), every }]);
      publish(ctx.userId, { type: "refresh", what: "upcoming" });
      return { task_id: t!.id, next_run: first.toISOString() };
    },
  },
  {
    name: "schedule_cancel",
    skill: "Scheduling",
    status: "Updating your schedule",
    description: "Cancel a scheduled task by id.",
    parameters: obj({ task_id: num("Task id") }, ["task_id"]),
    async run({ task_id }, ctx) {
      await db
        .update(scheduledTasksTable)
        .set({ enabled: false, lastResult: "Cancelled" })
        .where(and(eq(scheduledTasksTable.id, task_id), eq(scheduledTasksTable.userId, ctx.userId)));
      publish(ctx.userId, { type: "refresh", what: "upcoming" });
      await ctx.activity("schedule", `Cancelled scheduled task #${task_id}`, {}, "Scheduling");
      return { ok: true };
    },
  },
  {
    name: "schedule_list",
    skill: "Scheduling",
    status: "Checking your schedule",
    subagentSafe: true,
    description: "List upcoming scheduled tasks and reminders.",
    parameters: obj({}),
    async run(_a, ctx) {
      return {
        tasks: await db
          .select()
          .from(scheduledTasksTable)
          .where(and(eq(scheduledTasksTable.userId, ctx.userId), eq(scheduledTasksTable.enabled, true))),
      };
    },
  },
];

const ARTIFACT_GUIDE =
  "Self-contained HTML only: inline CSS/JS, no CDN scripts, external fonts, images or media. Embed assets as data: URLs. Mobile-first, clean, readable. Use window.amuse.getData()/setData(obj) to persist interactive state.";

export const makerTools: ToolDef[] = [
  {
    name: "create_artifact",
    skill: "Artifacts",
    status: "Making something",
    description:
      "Create a rich artifact the person can open: an itinerary, tracker, dashboard, study guide, comparison table, web page (kind=html) or a formatted document (kind=markdown). " +
      ARTIFACT_GUIDE,
    parameters: obj({ kind: { type: "string", enum: ["html", "markdown"] }, title: str("Title"), content: str("Full HTML or Markdown") }, [
      "kind",
      "title",
      "content",
    ]),
    async run({ kind, title, content }, ctx) {
      await ctx.setStatus("Making something");
      const [a] = await db.insert(artifactsTable).values({ userId: ctx.userId, chatId: ctx.chatId, kind, title, content }).returning();
      await ctx.activity("skill", `Created ${kind === "html" ? "an interactive page" : "a document"}: ${title}`, { artifactId: a!.id }, "Artifacts");
      ctx.addParts([{ type: "artifact", artifactId: a!.id, kind, title }]);
      return { artifact_id: a!.id, shown_to_person: true };
    },
  },
  {
    name: "update_artifact",
    skill: "Artifacts",
    status: "Making something",
    description: "Replace the content of an existing artifact (e.g. after the person asks for changes).",
    parameters: obj({ artifact_id: num("Artifact id"), title: str("New title"), content: str("Full new content") }, ["artifact_id", "content"]),
    async run({ artifact_id, title, content }, ctx) {
      const [a] = await db
        .select()
        .from(artifactsTable)
        .where(and(eq(artifactsTable.id, artifact_id), eq(artifactsTable.userId, ctx.userId)));
      if (!a) return { error: "No such artifact" };
      await db
        .update(artifactsTable)
        .set({ content, title: title ?? a.title, updatedAt: new Date() })
        .where(eq(artifactsTable.id, a.id));
      ctx.addParts([{ type: "artifact", artifactId: a.id, kind: a.kind, title: title ?? a.title }]);
      await ctx.activity("skill", `Updated "${title ?? a.title}"`, {}, "Artifacts");
      return { ok: true };
    },
  },
];

export const spaceTools: ToolDef[] = [
  {
    name: "space_create",
    skill: "Spaces",
    status: "Building a space",
    description:
      "Build a Space: a personal mini-app that lives in the person's sidebar (gift tracker, school dashboard, trip planner, word game...). Provide complete HTML. " +
      ARTIFACT_GUIDE +
      " Seed initial data in 'data'. If it should stay up to date, set refresh_prompt (what to fetch/update) and refresh_every_minutes; on refresh you'll be asked to call space_update with new data.",
    parameters: obj(
      {
        title: str("Space name"),
        emoji: str("Emoji icon"),
        description: str("One line"),
        html: str("Full HTML app"),
        data: { type: "object", description: "Initial JSON data", additionalProperties: true },
        refresh_prompt: str("How to refresh the data in the background"),
        refresh_every_minutes: num("Refresh interval minutes (>=60)"),
      },
      ["title", "html"],
    ),
    async run(a, ctx) {
      await ctx.setStatus("Building a space");
      if (a.refresh_prompt && a.refresh_every_minutes) {
        const error = schedulePolicy(ctx.trigger, 0, a.refresh_every_minutes);
        if (error) return { error };
        if (
          (await check({
            ...ctx,
            toolName: "schedule_task",
            actionClass: "write",
            purpose: `Schedule refresh for "${a.title}"`,
            details: { prompt: a.refresh_prompt, every: a.refresh_every_minutes },
            forceAsk: true,
          })) === "deny"
        )
          return { error: "The person denied this refresh schedule." };
      }
      const [s] = await db
        .insert(spacesTable)
        .values({
          userId: ctx.userId,
          title: a.title,
          emoji: a.emoji ?? "✨",
          description: a.description ?? "",
          html: a.html,
          data: a.data ?? {},
          refreshPrompt: a.refresh_prompt ?? null,
        })
        .returning();
      if (a.refresh_prompt && a.refresh_every_minutes) {
        await insertSchedule(ctx.trigger, {
          userId: ctx.userId,
          kind: "space_refresh",
          title: `Refresh ${a.title}`,
          prompt: a.refresh_prompt,
          spaceId: s!.id,
          intervalMinutes: Math.max(60, Math.round(a.refresh_every_minutes)),
          nextRunAt: new Date(Date.now() + Math.max(60, a.refresh_every_minutes) * 60000),
        });
      }
      await ctx.activity("skill", `Built the space "${a.title}"`, { spaceId: s!.id }, "Spaces");
      ctx.addParts([{ type: "space", spaceId: s!.id, title: a.title, emoji: a.emoji ?? "✨" }]);
      publish(ctx.userId, { type: "refresh", what: "spaces" });
      return { space_id: s!.id };
    },
  },
  {
    name: "space_update",
    skill: "Spaces",
    status: "Updating a space",
    description: "Update a Space's HTML (to change how it looks/works), its data (merge or replace), or title.",
    parameters: obj(
      {
        space_id: num("Space id"),
        html: str("Full new HTML"),
        data: { type: "object", additionalProperties: true },
        replace_data: { type: "boolean" },
        title: str("New title"),
      },
      ["space_id"],
    ),
    async run(a, ctx) {
      const [s] = await db
        .select()
        .from(spacesTable)
        .where(and(eq(spacesTable.id, a.space_id), eq(spacesTable.userId, ctx.userId)));
      if (!s) return { error: "No such space" };
      const asks = persistenceNeedsApproval(hasUntrustedRead(ctx.runId), "space_update", "", a.html != null && a.html !== s.html);
      if (
        (await check({
          ...ctx,
          toolName: "space_update",
          actionClass: asks ? "write" : "internal",
          forceAsk: asks,
          target: String(s.id),
          purpose: `Update space "${s.title}"`,
          details: { html: a.html, data: a.data },
        })) === "deny"
      )
        return { error: "Denied" };
      const data = a.data ? (a.replace_data ? a.data : { ...s.data, ...a.data }) : s.data;
      await db
        .update(spacesTable)
        .set({ html: a.html ?? s.html, data, title: a.title ?? s.title, updatedAt: new Date(), lastRefreshedAt: a.data ? new Date() : s.lastRefreshedAt })
        .where(eq(spacesTable.id, s.id));
      await ctx.activity("skill", `Updated the space "${a.title ?? s.title}"`, {}, "Spaces");
      publish(ctx.userId, { type: "refresh", what: "spaces" });
      return { ok: true };
    },
  },
  {
    name: "space_get",
    skill: "Spaces",
    status: "Opening a space",
    subagentSafe: true,
    description: "Read a Space's current data and HTML (to modify it), or list spaces when space_id is omitted.",
    parameters: obj({ space_id: num("Space id") }),
    async run({ space_id }, ctx) {
      if (!space_id)
        return {
          spaces: (await db.select().from(spacesTable).where(eq(spacesTable.userId, ctx.userId))).map((s) => ({
            id: s.id,
            title: s.title,
            description: s.description,
          })),
        };
      const [s] = await db
        .select()
        .from(spacesTable)
        .where(and(eq(spacesTable.id, space_id), eq(spacesTable.userId, ctx.userId)));
      return s ? { id: s.id, title: s.title, data: s.data, html: s.html.slice(0, 30000) } : { error: "No such space" };
    },
  },
];

export const trackingTools: ToolDef[] = [
  {
    name: "tracking_list",
    skill: "Tracking",
    status: "Checking tracked items",
    subagentSafe: true,
    description: "List open (or closed) tracking items (todos, open questions, meetings/trips) and their attached scheduled routines.",
    parameters: obj({ include_closed: { type: "boolean", description: "Include done/cancelled items" } }),
    async run(a, ctx) {
      const rows = await db
        .select()
        .from(trackingItemsTable)
        .where(a.include_closed ? eq(trackingItemsTable.userId, ctx.userId) : and(eq(trackingItemsTable.userId, ctx.userId), eq(trackingItemsTable.status, "open")))
        .orderBy(desc(trackingItemsTable.id))
        .limit(50);
      const tasks = await db
        .select({ id: scheduledTasksTable.id, trackingItemId: scheduledTasksTable.trackingItemId, kind: scheduledTasksTable.kind, title: scheduledTasksTable.title, nextRunAt: scheduledTasksTable.nextRunAt, enabled: scheduledTasksTable.enabled })
        .from(scheduledTasksTable)
        .where(eq(scheduledTasksTable.userId, ctx.userId));
      return {
        items: rows.map((r) => ({
          ...r,
          routines: tasks.filter((t) => t.trackingItemId === r.id),
        })),
      };
    },
  },
  {
    name: "tracking_upsert",
    skill: "Tracking",
    status: "Updating tracked item",
    description: "Create or update a tracking item (todo, question, meeting). Updates existing item when item_id or idempotency_key matches; auto-schedules a prep check for meetings >2h ahead.",
    parameters: obj(
      {
        item_id: num("Existing tracking item id to update"),
        kind: { type: "string", enum: ["todo", "question", "meeting"], description: "Item kind" },
        content: str("Concise description (max 200 chars, no relative words like tomorrow)"),
        due_at: str("Optional ISO 8601 timestamp"),
        due_text: str("Optional vague due text (e.g. next week)"),
        source_ref: str("Optional source reference (message/email/event id)"),
        idempotency_key: str("Optional stable key to deduplicate"),
        auto_prep: { type: "boolean", description: "Auto-schedule prep task for meetings (default true)" },
      },
      ["content"],
    ),
    async run(a, ctx) {
      const content = String(a.content).trim().slice(0, 200);
      const kind = ["todo", "question", "meeting"].includes(String(a.kind)) ? String(a.kind) : "todo";
      const dueAt = a.due_at ? new Date(String(a.due_at)) : null;
      const validDue = dueAt && !Number.isNaN(dueAt.getTime()) ? dueAt : null;

      let existing = null as typeof trackingItemsTable.$inferSelect | null;
      if (a.item_id) {
        const [r] = await db.select().from(trackingItemsTable).where(and(eq(trackingItemsTable.id, Number(a.item_id)), eq(trackingItemsTable.userId, ctx.userId)));
        existing = r ?? null;
      } else if (a.idempotency_key) {
        const [r] = await db
          .select()
          .from(trackingItemsTable)
          .where(and(eq(trackingItemsTable.userId, ctx.userId), eq(trackingItemsTable.idempotencyKey, String(a.idempotency_key))));
        existing = r ?? null;
      }

      let row: typeof trackingItemsTable.$inferSelect;
      if (existing) {
        const [u] = await db
          .update(trackingItemsTable)
          .set({
            kind,
            content,
            dueAt: validDue ?? existing.dueAt,
            dueText: a.due_text !== undefined ? String(a.due_text) : existing.dueText,
            sourceRef: a.source_ref !== undefined ? String(a.source_ref) : existing.sourceRef,
            revision: existing.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(trackingItemsTable.id, existing.id))
          .returning();
        row = u!;
      } else {
        const [c] = await db
          .insert(trackingItemsTable)
          .values({
            userId: ctx.userId,
            kind,
            content,
            dueAt: validDue,
            dueText: a.due_text ? String(a.due_text) : null,
            sourceRef: a.source_ref ? String(a.source_ref) : null,
            idempotencyKey: a.idempotency_key ? String(a.idempotency_key) : null,
          })
          .returning();
        row = c!;
        if (kind === "meeting" && validDue && a.auto_prep !== false && validDue.getTime() - Date.now() > 2 * 3600_000) {
          const leadMs = validDue.getTime() - Date.now() > 20 * 3600_000 ? 18 * 3600_000 : 2 * 3600_000;
          await db.insert(scheduledTasksTable).values({
            userId: ctx.userId,
            kind: "prep",
            trackingItemId: row.id,
            title: `Prep: ${content.slice(0, 60)}`,
            prompt: `Look up first: ${content}. Check google (mail/calendar), memory_search, and web if helpful, create a concise prep artifact (create -> artifact_create), and notify the user with key points and the artifact.`,
            nextRunAt: new Date(validDue.getTime() - leadMs),
            enabled: true,
          });
        }
      }
      await ctx.activity("skill", `${existing ? "Updated" : "Tracked"} ${kind}: ${content}`, { id: row.id }, "Tracking");
      return { item: row };
    },
  },
  {
    name: "tracking_done",
    skill: "Tracking",
    status: "Closing tracked item",
    description: "Mark a tracking item done or cancelled and disable its linked scheduled routines.",
    parameters: obj({ item_id: num("Tracking item id"), status: { type: "string", enum: ["done", "cancelled"] } }, ["item_id"]),
    async run(a, ctx) {
      const status = a.status === "cancelled" ? "cancelled" : "done";
      const [existing] = await db
        .select()
        .from(trackingItemsTable)
        .where(and(eq(trackingItemsTable.id, Number(a.item_id)), eq(trackingItemsTable.userId, ctx.userId)));
      if (!existing) return { error: "No such tracking item" };
      const [updated] = await db
        .update(trackingItemsTable)
        .set({ status, revision: existing.revision + 1, updatedAt: new Date() })
        .where(eq(trackingItemsTable.id, existing.id))
        .returning();
      await db
        .update(scheduledTasksTable)
        .set({ enabled: false, lastResult: `Tracking item ${status}` })
        .where(and(eq(scheduledTasksTable.userId, ctx.userId), eq(scheduledTasksTable.trackingItemId, existing.id)));
      await ctx.activity("skill", `Marked tracking item #${existing.id} ${status}`, {}, "Tracking");
      return { item: updated };
    },
  },
];

const VALID_BLOCK_TYPES = new Set(["p", "h1", "h2", "h3", "bullet", "todo", "callout", "quote", "code", "divider"]);

function parseBlocksInput(markdown?: unknown, blocksRaw?: unknown): DocBlock[] {
  if (Array.isArray(blocksRaw)) {
    return blocksRaw
      .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
      .map((b) => {
        const type = VALID_BLOCK_TYPES.has(String(b.type)) ? (String(b.type) as DocBlock["type"]) : "p";
        return {
          id: String(b.id || makeBlockId()),
          type,
          text: String(b.text ?? ""),
          ...(type === "todo" ? { checked: Boolean(b.checked) } : {}),
        };
      });
  }
  if (typeof markdown === "string" && markdown.trim()) {
    return markdownToBlocks(markdown);
  }
  return [{ id: makeBlockId(), type: "p", text: "" }];
}

export const docTools: ToolDef[] = [
  {
    name: "doc_list",
    skill: "Docs",
    status: "Listing docs",
    description: "List collaborative Notion-style documents.",
    parameters: obj({}),
    async run(_a, ctx) {
      const rows = await db
        .select()
        .from(documentsTable)
        .where(eq(documentsTable.userId, ctx.userId))
        .orderBy(desc(documentsTable.updatedAt))
        .limit(50);
      return {
        docs: rows.map((d) => ({
          id: d.id,
          title: d.title,
          emoji: d.emoji,
          updated_at: d.updatedAt,
          block_count: Array.isArray(d.blocks) ? d.blocks.length : 0,
        })),
      };
    },
  },
  {
    name: "doc_get",
    skill: "Docs",
    status: "Reading doc",
    description: "Read a collaborative document and its blocks (with block ids and comments).",
    parameters: obj({ doc_id: num("Document id") }, ["doc_id"]),
    async run({ doc_id }, ctx) {
      const [doc] = await db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.id, Number(doc_id)), eq(documentsTable.userId, ctx.userId)));
      if (!doc) return { error: "Document not found" };
      return { doc };
    },
  },
  {
    name: "doc_create",
    skill: "Docs",
    status: "Creating doc",
    description: "Create a collaborative Notion-style document from markdown or blocks.",
    parameters: obj(
      {
        title: str("Document title"),
        emoji: str("Optional single emoji"),
        markdown: str("Optional markdown body to parse into blocks"),
        blocks: { type: "array", items: { type: "object" }, description: "Optional array of block objects" },
      },
      ["title"],
    ),
    async run(a, ctx) {
      const title = String(a.title).trim().slice(0, 160) || "Untitled";
      const emoji = String(a.emoji ?? "📝").trim().slice(0, 16) || "📝";
      const blocks = parseBlocksInput(a.markdown, a.blocks);
      const slug = slugifyDoc(title);
      const [doc] = await db
        .insert(documentsTable)
        .values({ userId: ctx.userId, title, emoji, slug, blocks })
        .returning();
      await syncDocToWorkspace(ctx.userId, doc!);
      publish(ctx.userId, { type: "refresh", what: "docs" });
      await ctx.activity("skill", `Created doc: ${title}`, { docId: doc!.id }, "Docs");
      return { doc_id: doc!.id, title: doc!.title, url: `/docs/${doc!.id}`, block_count: blocks.length };
    },
  },
  {
    name: "doc_update_block",
    skill: "Docs",
    status: "Updating doc block",
    description: "Update a single block in place inside a collaborative document without touching other blocks.",
    parameters: obj(
      {
        doc_id: num("Document id"),
        block_id: str("Target block id"),
        content: str("New text for the block"),
        block_type: { type: "string", enum: ["p", "h1", "h2", "h3", "bullet", "todo", "callout", "quote", "code", "divider"] },
        checked: { type: "boolean", description: "Checked state for todo blocks" },
      },
      ["doc_id", "block_id"],
    ),
    async run(a, ctx) {
      const [existing] = await db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.id, Number(a.doc_id)), eq(documentsTable.userId, ctx.userId)));
      if (!existing) return { error: "Document not found" };
      const blocks = [...(Array.isArray(existing.blocks) ? existing.blocks : [])];
      const idx = blocks.findIndex((b) => b.id === String(a.block_id));
      if (idx === -1) return { error: `Block ${a.block_id} not found` };
      const cur = blocks[idx]!;
      const nextType = a.block_type && VALID_BLOCK_TYPES.has(String(a.block_type)) ? (String(a.block_type) as DocBlock["type"]) : cur.type;
      blocks[idx] = {
        ...cur,
        type: nextType,
        ...(a.content !== undefined ? { text: String(a.content) } : {}),
        ...(nextType === "todo" ? { checked: a.checked !== undefined ? Boolean(a.checked) : Boolean(cur.checked) } : {}),
      };
      const [doc] = await db
        .update(documentsTable)
        .set({ blocks, updatedAt: new Date() })
        .where(and(eq(documentsTable.id, existing.id), eq(documentsTable.userId, ctx.userId)))
        .returning();
      await syncDocToWorkspace(ctx.userId, doc!);
      publish(ctx.userId, { type: "refresh", what: "docs" });
      await ctx.activity("skill", `Updated block ${cur.id} in "${existing.title}"`, { docId: existing.id }, "Docs");
      return { ok: true, doc_id: existing.id, block: blocks[idx] };
    },
  },
  {
    name: "doc_append_blocks",
    skill: "Docs",
    status: "Appending to doc",
    description: "Append blocks (from markdown or blocks array) to a collaborative document, optionally after a specific block_id.",
    parameters: obj(
      {
        doc_id: num("Document id"),
        markdown: str("Markdown to append as blocks"),
        blocks: { type: "array", items: { type: "object" }, description: "Blocks to append" },
        after_block_id: str("Optional block id to insert after"),
      },
      ["doc_id"],
    ),
    async run(a, ctx) {
      const [existing] = await db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.id, Number(a.doc_id)), eq(documentsTable.userId, ctx.userId)));
      if (!existing) return { error: "Document not found" };
      const added = parseBlocksInput(a.markdown, a.blocks);
      const blocks = [...(Array.isArray(existing.blocks) ? existing.blocks : [])];
      if (a.after_block_id) {
        const idx = blocks.findIndex((b) => b.id === String(a.after_block_id));
        if (idx !== -1) blocks.splice(idx + 1, 0, ...added);
        else blocks.push(...added);
      } else {
        blocks.push(...added);
      }
      const [doc] = await db
        .update(documentsTable)
        .set({ blocks, updatedAt: new Date() })
        .where(and(eq(documentsTable.id, existing.id), eq(documentsTable.userId, ctx.userId)))
        .returning();
      await syncDocToWorkspace(ctx.userId, doc!);
      publish(ctx.userId, { type: "refresh", what: "docs" });
      await ctx.activity("skill", `Appended ${added.length} block(s) to "${existing.title}"`, { docId: existing.id }, "Docs");
      return { ok: true, doc_id: existing.id, added_count: added.length };
    },
  },
  {
    name: "doc_comment_reply",
    skill: "Docs",
    status: "Replying on doc",
    description: "Reply to a comment thread on a document block (and optionally mark the thread resolved).",
    parameters: obj(
      {
        doc_id: num("Document id"),
        block_id: str("Target block id"),
        content: str("Reply message"),
        resolve: { type: "boolean", description: "Mark comments on this block resolved" },
      },
      ["doc_id", "block_id", "content"],
    ),
    async run(a, ctx) {
      const [existing] = await db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.id, Number(a.doc_id)), eq(documentsTable.userId, ctx.userId)));
      if (!existing) return { error: "Document not found" };
      const blocks = [...(Array.isArray(existing.blocks) ? existing.blocks : [])];
      const idx = blocks.findIndex((b) => b.id === String(a.block_id));
      if (idx === -1) return { error: `Block ${a.block_id} not found` };
      const cur = blocks[idx]!;
      const comment: DocComment = {
        id: `c_${Math.random().toString(36).slice(2, 8)}`,
        author: "agent",
        text: String(a.content),
        createdAt: new Date().toISOString(),
        ...(a.resolve ? { resolved: true } : {}),
      };
      const prevComments = (cur.comments ?? []).map((c) => (a.resolve ? { ...c, resolved: true } : c));
      blocks[idx] = { ...cur, comments: [...prevComments, comment] };
      const [doc] = await db
        .update(documentsTable)
        .set({ blocks, updatedAt: new Date() })
        .where(and(eq(documentsTable.id, existing.id), eq(documentsTable.userId, ctx.userId)))
        .returning();
      await syncDocToWorkspace(ctx.userId, doc!);
      publish(ctx.userId, { type: "refresh", what: "docs" });
      return { ok: true, doc_id: existing.id, comment };
    },
  },
];
