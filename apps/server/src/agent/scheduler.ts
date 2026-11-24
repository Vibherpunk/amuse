import { and, desc, eq, lte } from "drizzle-orm";
import { agentsTable, db, goalsTable, messagesTable, notificationsTable, runsTable, scheduledTasksTable, settingsTable, spacesTable, usersTable } from "@amuse/db";
import { logger } from "../lib/logger";
import { publish } from "./bus";
import { activeRunFor, getBackgroundChatId, startRun } from "./loop";
import { checkChatReviewDue, ensureProactiveSetup, isChatQuiet, pollExternalEvents, runNightlyConsolidation, runProactiveDreaming } from "./proactive";
import { getMainChatId, readFile as readWorkspaceFile } from "./workspace";
import { tipMessage, TIPS } from "./tips";
import { nextSchedule, reminderText, scheduledRunState, tipEligible } from "./robustness";
import { assertWithinLimit, pauseBackgroundJobs, UsageLimitError } from "./usage";

/**
 * Heartbeat scheduler: runs due reminders, monitors and space refreshes in the
 * background. Reminders post directly; other jobs start a background agent run
 * that decides whether the result is worth surfacing (notify tool).
 */
let timer: NodeJS.Timeout | null = null;
let ticking = false;
const forced = new Set<string>();

/** Test hook: make this user's heartbeat due now and skip the cost gate for one tick. */
export async function forceHeartbeat(userId: string) {
  forced.add(userId);
  try {
    await db
      .update(scheduledTasksTable)
      .set({ nextRunAt: new Date(Date.now() - 1000), enabled: true })
      .where(and(eq(scheduledTasksTable.userId, userId), eq(scheduledTasksTable.kind, "heartbeat")));
    while (ticking) await new Promise((r) => setTimeout(r, 200));
    await tick();
  } finally {
    forced.delete(userId);
  }
}

export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const due = await db
      .select()
      .from(scheduledTasksTable)
      .where(and(eq(scheduledTasksTable.enabled, true), lte(scheduledTasksTable.nextRunAt, new Date())))
      .limit(10);
    for (const t of due) {
      if (t.kind === "tip") {
        const mainId = await getMainChatId(t.userId);
        const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.userId, t.userId));
        if (!tipEligible(agent?.hatchedAt ?? null, !!activeRunFor(mainId))) {
          await db
            .update(scheduledTasksTable)
            .set({ nextRunAt: new Date(Math.max(Date.now() + 60000, (agent?.hatchedAt?.getTime() ?? Date.now()) + 86400000)) })
            .where(eq(scheduledTasksTable.id, t.id));
          continue;
        }
      }
      const advance = async (lastResult: string) => {
        await db
          .update(scheduledTasksTable)
          .set({ ...nextSchedule(t.intervalMinutes, t.nextRunAt), lastResult })
          .where(eq(scheduledTasksTable.id, t.id));
        publish(t.userId, { type: "refresh", what: "upcoming" });
      };
      if (t.kind === "reminder") {
        const mainId = await getMainChatId(t.userId);
        const content = reminderText(t.title);
        const [m] = await db.insert(messagesTable).values({ userId: t.userId, chatId: mainId, role: "assistant", content, proactive: true }).returning();
        publish(t.userId, { type: "message", chatId: mainId, message: m });
        const [n] = await db.insert(notificationsTable).values({ userId: t.userId, title: "Reminder", body: t.title, link: "/" }).returning();
        publish(t.userId, { type: "notification", notification: n });
        await advance("Reminded");
        continue;
      }
      if (t.kind === "tip") {
        const i = Number(t.prompt);
        if (Number.isInteger(i) && TIPS[i]) {
          const mainId = await getMainChatId(t.userId);
          const tip = tipMessage(i);
          const [m] = await db
            .insert(messagesTable)
            .values({ userId: t.userId, chatId: mainId, role: "assistant", content: tip.content, parts: tip.parts, proactive: true })
            .returning();
          publish(t.userId, { type: "message", chatId: mainId, message: m });
        }
        await advance("Delivered");
        continue;
      }
      try {
        await assertWithinLimit(t.userId);
      } catch (error) {
        if (!(error instanceof UsageLimitError)) throw error;
        await pauseBackgroundJobs(t.userId, error.resetsAt);
        continue;
      }
      if (t.kind === "heartbeat") {
        // Cheap gate: only spend a model run when proactivity is on, the person was active in the
        // last 3 days, they have active goals, and the last heartbeat run was 6+ hours ago.
        const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.userId, t.userId));
        const [lastMsg] = await db
          .select()
          .from(messagesTable)
          .where(and(eq(messagesTable.userId, t.userId), eq(messagesTable.role, "user")))
          .orderBy(desc(messagesTable.id))
          .limit(1);
        const goals = await db
          .select()
          .from(goalsTable)
          .where(and(eq(goalsTable.userId, t.userId), eq(goalsTable.status, "active")));
        const [lastHb] = await db
          .select()
          .from(runsTable)
          .where(and(eq(runsTable.userId, t.userId), eq(runsTable.title, "Heartbeat")))
          .orderBy(desc(runsTable.id))
          .limit(1);
        const active = lastMsg && Date.now() - lastMsg.createdAt.getTime() < 3 * 86400000;
        const due = !lastHb || Date.now() - lastHb.startedAt.getTime() > 6 * 3600000;
        if (!forced.has(t.userId) && scheduledRunState(t.lastResult)?.kind !== "retry" && (agent?.proactivity === "off" || !active || !goals.length || !due)) {
          await advance("Nothing needed");
          continue;
        }
      }
      const chatId = await getBackgroundChatId(t.userId, t.id);
      if (activeRunFor(chatId)) {
        // try again shortly
        await db
          .update(scheduledTasksTable)
          .set({ nextRunAt: new Date(Date.now() + 60000), enabled: true })
          .where(eq(scheduledTasksTable.id, t.id));
        continue;
      }
      let prompt = t.prompt;
      if (t.kind === "heartbeat") {
        const checklist = (await readWorkspaceFile(t.userId, "HEARTBEAT.md")) ?? "";
        // Like OpenClaw: an empty checklist (only headings/comments/whitespace) means skip the run.
        const meaningful = checklist.split("\n").some((l) => l.trim() && !/^#/.test(l.trim()) && !/^<!--/.test(l.trim()));
        if (!meaningful) {
          await advance("Checklist empty");
          continue;
        }
        prompt = `${t.prompt}\n\nYour HEARTBEAT.md checklist:\n${checklist.slice(0, 4000)}\n\nIf nothing needs attention, do not notify.`;
      }
      if (t.kind === "proactive_poll") {
        const mainId = await getMainChatId(t.userId);
        if (!(await isChatQuiet(t.userId, !!activeRunFor(mainId)))) {
          await db.update(scheduledTasksTable).set({ nextRunAt: new Date(Date.now() + 180_000), enabled: true }).where(eq(scheduledTasksTable.id, t.id));
          continue;
        }
        const [settings] = await db.select().from(settingsTable).where(eq(settingsTable.userId, t.userId));
        const tz = settings?.timezone ?? "America/Los_Angeles";
        const polled = await pollExternalEvents(t.userId, tz);
        const review = await checkChatReviewDue(t.userId);
        if (!polled.unseen.length && !review.due) {
          await advance(polled.skipped ? `Idle (${polled.skipped})` : "No new events");
          continue;
        }
        const blocks: string[] = [t.prompt];
        if (polled.unseen.length) {
          blocks.push("New unseen external events:\n" + polled.unseen.map((e) => `- [${e.source}] ${e.summary}`).join("\n"));
        }
        if (review.due && review.windowText) {
          blocks.push("Recent 20-message main chat window:\n<conversation>\n" + review.windowText + "\n</conversation>");
        }
        blocks.push("Read PROACTIVE_PREFERENCES.md and relevant skills/proactive/*.md playbooks. Update tracking items silently; call notify ONLY if the person should know now.");
        prompt = blocks.join("\n\n");
      }
      if (t.kind === "proactive_dream") {
        const mainId = await getMainChatId(t.userId);
        if (!(await isChatQuiet(t.userId, !!activeRunFor(mainId)))) {
          await db.update(scheduledTasksTable).set({ nextRunAt: new Date(Date.now() + 300_000), enabled: true }).where(eq(scheduledTasksTable.id, t.id));
          continue;
        }
        const [settings] = await db.select().from(settingsTable).where(eq(settingsTable.userId, t.userId));
        const tz = settings?.timezone ?? "America/Los_Angeles";
        const dRes = await runProactiveDreaming(t.userId, tz);
        const cRes = await runNightlyConsolidation(t.userId, tz);
        await advance(`Dreamed ${dRes.dreamed} (+${dRes.promoted} rules); report=${cRes.wroteReport}`);
        continue;
      }
      if (t.kind === "prep") {
        const mainId = await getMainChatId(t.userId);
        if (!(await isChatQuiet(t.userId, !!activeRunFor(mainId)))) {
          await db.update(scheduledTasksTable).set({ nextRunAt: new Date(Date.now() + 180_000), enabled: true }).where(eq(scheduledTasksTable.id, t.id));
          continue;
        }
      }
      if (t.kind === "space_refresh" && t.spaceId) {
        const [s] = await db.select().from(spacesTable).where(eq(spacesTable.id, t.spaceId));
        if (!s) {
          await advance("Space no longer exists");
          continue;
        }
        prompt = `Refresh the space "${s.title}" (space_id ${s.id}). ${t.prompt}\nRead it with space_get, gather fresh info, then call space_update with merged data. Only notify if something notable changed.`;
      }
      await startRun({
        userId: t.userId,
        chatId,
        trigger: t.kind === "space_refresh" ? "space" : "schedule",
        backgroundPrompt: prompt,
        title: t.title,
        scheduledTask: t,
      });
      publish(t.userId, { type: "refresh", what: "upcoming" });
    }
  } catch (err) {
    logger.error({ err }, "scheduler tick failed");
  } finally {
    ticking = false;
  }
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => void tick(), 30000);
  setTimeout(async () => {
    try {
      const users = await db.select({ id: usersTable.id }).from(usersTable);
      for (const u of users) await ensureProactiveSetup(u.id);
    } catch (err) {
      logger.warn({ err }, "ensureProactiveSetup on startup failed");
    }
    void tick();
  }, 5000);
}
