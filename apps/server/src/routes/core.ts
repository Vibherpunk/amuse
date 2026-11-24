import { TIPS } from "../agent/tips";
import { publish } from "../agent/bus";
import { Router, type IRouter } from "express";
import { and, asc, desc, eq, lt, ne } from "drizzle-orm";
import {
  activityTable,
  agentsTable,
  allowedSitesTable,
  approvalsTable,
  chatsTable,
  db,
  goalsTable,
  ideasTable,
  messagesTable,
  notificationsTable,
  scheduledTasksTable,
  settingsTable,
  usersTable,
  workspaceFilesTable,
  artifactsTable,
  spacesTable,
  connectorsTable,
  credentialsTable,
  mcpServersTable,
  grantsTable,
  runsTable,
  usageTable,
  browserSessionsTable,
  trackingItemsTable,
  proactiveDeliveriesTable,
  proactiveCluesTable,
  proactiveRuleVersionsTable,
} from "@amuse/db";
import { subscribe } from "../agent/bus";
import { activeRunFor, startRun, steer, stopRun } from "../agent/loop";
import { formatMeetingSessionMarkdown, pollExternalEvents, slugifyTitle } from "../agent/proactive";
import { resolveApproval } from "../agent/sentinel";
import { DAILY_LIMIT, getUsage, record } from "../agent/usage";
import { deleteFile, ensureUserSetup, getMainChatId, listFiles, readFile, today, writeFile } from "../agent/workspace";
import { jsonCompletion, MODELS, imageOpenai, openai, transcribeOpenai } from "../lib/ai";
import { forgetSetup, idParam, requireAuth, uid } from "./helpers";

const router: IRouter = Router();
router.use(requireAuth);

// ---------- me / agent ----------
router.get("/capabilities", (_req, res) => {
  res.json({ serverSpeech: true });
});

router.get("/me", async (req, res) => {
  const userId = uid(req);
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
  const [settings] = await db.select().from(settingsTable).where(eq(settingsTable.userId, userId));
  const mainChatId = await getMainChatId(userId);
  const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  res.json({ user: { id: userId, name: owner?.name ?? null }, agent, settings, usage: await getUsage(userId), mainChatId });
});

router.post("/agent/avatar-options", async (req, res) => {
  const userId = uid(req);
  const { look = "a small round fluffy creature", style = "soft 3D clay" } = req.body ?? {};
  const prompt = `A 2x2 grid sheet of four distinct character avatar options for a friendly personal AI companion. Each cell: one cute mascot, centered, plain pastel background, no text. Look: ${String(look).slice(0, 200)}. Style: ${String(style).slice(0, 80)}. Make the four variations differ in color and expression.`;
  try {
    const r = await imageOpenai.images.generate({ model: MODELS.image, prompt, size: "1024x1024", quality: "low", output_format: "jpeg", n: 1 } as any);
    const b64 = (r.data?.[0] as any)?.b64_json;
    await record(userId, { images: 1 });
    res.json({ sheet: `data:image/jpeg;base64,${b64}` });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post("/agent/hatch", async (req, res) => {
  const userId = uid(req);
  const { name, vibe, emoji, avatarUrl, avatarStyle, aboutMe } = req.body ?? {};
  if (!name || String(name).length > 40) {
    res.status(400).json({ error: "Name is required" });
    return;
  }
  await db
    .update(agentsTable)
    .set({ name, vibe: vibe ?? "", emoji: emoji ?? "🪺", avatarUrl: avatarUrl ?? null, avatarStyle: avatarStyle ?? null, hatchedAt: new Date() })
    .where(eq(agentsTable.userId, userId));
  await writeFile(userId, "IDENTITY.md", `# Identity\n\n- Name: ${name}\n- Vibe: ${vibe ?? ""}\n- Emoji: ${emoji ?? "🪺"}\n`);
  const soul = (await readFile(userId, "SOUL.md")) ?? "";
  if (vibe && !soul.includes("## My vibe")) await writeFile(userId, "SOUL.md", soul.trimEnd() + `\n\n## My vibe\n${vibe}\n`);
  const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  const first =
    String(req.body?.ownerName ?? "")
      .trim()
      .slice(0, 80) ||
    owner?.name ||
    null;
  if (first) await db.update(usersTable).set({ name: first }).where(eq(usersTable.id, userId));
  if (first || aboutMe)
    await writeFile(userId, "USER.md", `# About my person\n\n${first ? `- Name: ${first}\n` : ""}${aboutMe ? `- Wants help with: ${aboutMe}\n` : ""}`);
  await db
    .update(settingsTable)
    .set({ onboardedAt: new Date(), timezone: req.body?.timezone ?? "America/Los_Angeles" })
    .where(eq(settingsTable.userId, userId));
  // Onboarding tips as starter ideas
  const tips = [
    {
      title: "Plan my week",
      body: "Give me your week and I'll turn it into a plan.",
      prompt: "Help me plan my week. Ask me what's coming up, then make a day-by-day plan.",
      emoji: "🗓️",
      category: "productivity",
    },
    {
      title: "Set a goal",
      body: "Tell me something you want to achieve. I'll make a plan and keep you on track.",
      prompt: "I want to set a goal. Help me pick one and build a plan.",
      emoji: "🎯",
      category: "goals",
    },
    {
      title: "Make me a podcast",
      body: "A 2-minute episode on anything you're curious about.",
      prompt: "Make me a 2-minute podcast about something fascinating in science this week.",
      emoji: "🎧",
      category: "fun",
    },
    {
      title: "Watch the weather",
      body: "I'll check every morning and tell you if it's going to rain.",
      prompt: "Every morning at 7am, check the weather where I live and tell me only if it's going to rain.",
      emoji: "☔",
      category: "everyday",
    },
    {
      title: "Build a space",
      body: "A custom mini-app: a gift tracker, reading list, or anything.",
      prompt: "Build me a space to track gift ideas for friends and family.",
      emoji: "✨",
      category: "spaces",
    },
  ];
  await db.insert(ideasTable).values(tips.map((t) => ({ ...t, userId, source: "onboarding" })));
  await db.insert(scheduledTasksTable).values({
    userId,
    kind: "heartbeat",
    title: "Heartbeat",
    prompt:
      "Heartbeat check: review active goals, upcoming tasks and recent conversation. If something is time-sensitive or there's a genuinely useful next step, do it or notify. Otherwise do nothing.",
    intervalMinutes: 30,
    nextRunAt: new Date(Date.now() + 30 * 60000),
  });
  // First-week tips: the first a few minutes after hatching, then one a day.
  await db.insert(scheduledTasksTable).values(
    TIPS.map((t, i) => ({
      userId,
      kind: "tip",
      title: `Tip ${i + 1}: ${t.title}`,
      prompt: String(i),
      nextRunAt: new Date(Date.now() + (i === 0 ? 3 * 60000 : i * 86400000)),
    })),
  );
  const mainId = await getMainChatId(userId);
  await startRun({ userId, chatId: mainId, trigger: "user" });
  res.json({ ok: true });
});

router.patch("/agent", async (req, res) => {
  const userId = uid(req);
  const patch: Record<string, unknown> = {};
  for (const k of ["name", "vibe", "emoji", "avatarUrl", "avatarStyle", "proactivity"]) if (Object.hasOwn(req.body ?? {}, k)) patch[k] = req.body[k];
  if (Object.keys(patch).length) await db.update(agentsTable).set(patch).where(eq(agentsTable.userId, userId));
  if (patch.name || patch.vibe || patch.emoji) {
    const [a] = await db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
    await writeFile(userId, "IDENTITY.md", `# Identity\n\n- Name: ${a!.name}\n- Vibe: ${a!.vibe ?? ""}\n- Emoji: ${a!.emoji ?? "🪺"}\n`);
  }
  if (patch.proactivity) {
    const soul = (await readFile(userId, "SOUL.md")) ?? "";
    const line = `Proactivity: ${patch.proactivity} (off = never message unprompted; low = only urgent; normal = when genuinely useful; high = share ideas freely).`;
    await writeFile(userId, "SOUL.md", soul.replace(/\nProactivity: .*\n?/, "\n").trimEnd() + "\n" + line + "\n");
  }
  res.json({ ok: true });
});

// ---------- events (SSE) ----------
router.get("/events", (req, res) => {
  const userId = uid(req);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(`event: hello\ndata: {}\n\n`);
  const off = subscribe(userId, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
  const ping = setInterval(() => res.write(`: ping\n\n`), 20000);
  req.on("close", () => {
    off();
    clearInterval(ping);
  });
});

// ---------- chats ----------
router.get("/chats", async (req, res) => {
  const rows = await db
    .select()
    .from(chatsTable)
    .where(and(eq(chatsTable.userId, uid(req)), ne(chatsTable.kind, "background"), eq(chatsTable.archived, false)))
    .orderBy(desc(chatsTable.updatedAt));
  res.json({ chats: rows });
});

router.post("/chats", async (req, res) => {
  const [c] = await db
    .insert(chatsTable)
    .values({ userId: uid(req), kind: "side", title: String(req.body?.title ?? "New side chat").slice(0, 80) })
    .returning();
  res.json({ chat: c });
});

router.patch("/chats/:id", async (req, res) => {
  await db
    .update(chatsTable)
    .set({ title: String(req.body?.title ?? "Side chat").slice(0, 80), archived: !!req.body?.archived })
    .where(and(eq(chatsTable.id, idParam(req)), eq(chatsTable.userId, uid(req)), eq(chatsTable.kind, "side")));
  res.json({ ok: true });
});

router.get("/chats/:id/messages", async (req, res) => {
  const userId = uid(req);
  const chatId = idParam(req);
  const before = req.query.before ? Number(req.query.before) : null;
  const where = before
    ? and(eq(messagesTable.chatId, chatId), eq(messagesTable.userId, userId), lt(messagesTable.id, before))
    : and(eq(messagesTable.chatId, chatId), eq(messagesTable.userId, userId));
  const rows = await db.select().from(messagesTable).where(where).orderBy(desc(messagesTable.id)).limit(60);
  const run = activeRunFor(chatId);
  res.json({ messages: rows.reverse(), running: !!run, runId: run?.runId ?? null });
});

router.post("/chats/:id/messages", async (req, res) => {
  const userId = uid(req);
  const chatId = idParam(req);
  const content = String(req.body?.content ?? "")
    .trim()
    .slice(0, 8000);
  if (!content) {
    res.status(400).json({ error: "Empty message" });
    return;
  }
  const [chat] = await db
    .select()
    .from(chatsTable)
    .where(and(eq(chatsTable.id, chatId), eq(chatsTable.userId, userId)));
  if (!chat) {
    res.status(404).json({ error: "No such chat" });
    return;
  }
  const [m] = await db.insert(messagesTable).values({ userId, chatId, role: "user", content }).returning();
  if (chat.kind === "side" && chat.title === "New side chat") {
    await db
      .update(chatsTable)
      .set({ title: content.slice(0, 48) })
      .where(eq(chatsTable.id, chatId));
  }
  let steered = false;
  let started = false;
  if (activeRunFor(chatId)) steered = steer(chatId, content);
  else started = !!(await startRun({ userId, chatId, trigger: "user", voice: req.body?.voice === true }));
  res.json({ message: m, steered, started });
});

router.post("/chats/:id/stop", async (req, res) => {
  res.json({ stopped: await stopRun(uid(req), idParam(req)) });
});

// ---------- approvals ----------
router.get("/approvals", async (req, res) => {
  const rows = await db
    .select()
    .from(approvalsTable)
    .where(and(eq(approvalsTable.userId, uid(req)), eq(approvalsTable.status, "pending")))
    .orderBy(asc(approvalsTable.id));
  res.json({ approvals: rows });
});

router.get("/approvals/:id", async (req, res) => {
  const [a] = await db
    .select()
    .from(approvalsTable)
    .where(and(eq(approvalsTable.userId, uid(req)), eq(approvalsTable.id, idParam(req))));
  res.json({ approval: a ?? null });
});

router.post("/approvals/:id", async (req, res) => {
  try {
    const a = await resolveApproval(uid(req), idParam(req), String(req.body?.grant));
    res.json({ approval: a });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ---------- activity / upcoming ----------
router.get("/activity", async (req, res) => {
  const rows = await db
    .select()
    .from(activityTable)
    .where(eq(activityTable.userId, uid(req)))
    .orderBy(desc(activityTable.id))
    .limit(200);
  const runs = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.userId, uid(req)))
    .orderBy(desc(runsTable.id))
    .limit(20);
  res.json({ activity: rows, runs });
});

router.get("/upcoming", async (req, res) => {
  const rows = await db
    .select()
    .from(scheduledTasksTable)
    .where(and(eq(scheduledTasksTable.userId, uid(req)), eq(scheduledTasksTable.enabled, true), ne(scheduledTasksTable.kind, "tip")))
    .orderBy(asc(scheduledTasksTable.nextRunAt));
  res.json({ upcoming: rows });
});

router.delete("/upcoming/:id", async (req, res) => {
  await db
    .update(scheduledTasksTable)
    .set({ enabled: false, lastResult: "Cancelled" })
    .where(and(eq(scheduledTasksTable.id, idParam(req)), eq(scheduledTasksTable.userId, uid(req))));
  publish(uid(req), { type: "refresh", what: "upcoming" });
  res.json({ ok: true });
});

// ---------- goals ----------
router.get("/goals", async (req, res) => {
  res.json({
    goals: await db
      .select()
      .from(goalsTable)
      .where(eq(goalsTable.userId, uid(req)))
      .orderBy(desc(goalsTable.updatedAt)),
  });
});

router.patch("/goals/:id", async (req, res) => {
  const userId = uid(req);
  const [g] = await db
    .select()
    .from(goalsTable)
    .where(and(eq(goalsTable.id, idParam(req)), eq(goalsTable.userId, userId)));
  if (!g) {
    res.status(404).end();
    return;
  }
  let plan = g.plan;
  if (req.body?.toggleStep) plan = plan.map((s) => (s.id === req.body.toggleStep ? { ...s, done: !s.done } : s));
  await db
    .update(goalsTable)
    .set({ plan, status: req.body?.status ?? g.status, title: req.body?.title ?? g.title, updatedAt: new Date() })
    .where(eq(goalsTable.id, g.id));
  res.json({ ok: true });
});

router.delete("/goals/:id", async (req, res) => {
  await db.delete(goalsTable).where(and(eq(goalsTable.id, idParam(req)), eq(goalsTable.userId, uid(req))));
  res.json({ ok: true });
});

router.post("/goals", async (req, res) => {
  const userId = uid(req);
  const text = String(req.body?.text ?? "").trim();
  if (!text) {
    res.status(400).end();
    return;
  }
  const chatId = await getMainChatId(userId);
  await db.insert(messagesTable).values({ userId, chatId, role: "user", content: `New goal: ${text}. Make a plan for it.` });
  if (activeRunFor(chatId)) steer(chatId, `New goal: ${text}. Make a plan for it.`);
  else await startRun({ userId, chatId, trigger: "user" });
  res.json({ ok: true, chatId });
});

// ---------- ideas ----------
router.get("/ideas", async (req, res) => {
  res.json({
    ideas: await db
      .select()
      .from(ideasTable)
      .where(and(eq(ideasTable.userId, uid(req)), ne(ideasTable.status, "dismissed")))
      .orderBy(desc(ideasTable.id))
      .limit(60),
  });
});

router.post("/ideas/refresh", async (req, res) => {
  const userId = uid(req);
  const user = (await readFile(userId, "USER.md")) ?? "";
  const mem = (await readFile(userId, "MEMORY.md")) ?? "";
  const goals = await db.select().from(goalsTable).where(eq(goalsTable.userId, userId));
  const existing = await db.select({ title: ideasTable.title }).from(ideasTable).where(eq(ideasTable.userId, userId));
  const { data, tokensIn, tokensOut } = await jsonCompletion<{ ideas: { title: string; body: string; prompt: string; category: string; emoji: string }[] }>(
    "You generate personalised, concrete task ideas a capable personal AI agent (web research, browser, documents, images, podcasts, reminders, monitoring, goals, mini-app 'spaces', email/calendar if connected) could do for this person right now. Return JSON {ideas:[{title (<=6 words), body (one sentence, why it helps them), prompt (exact first-person request), category, emoji}]} with 6 ideas. Avoid repeating existing titles.",
    `About them:\n${user}\n\nMemory:\n${mem}\n\nGoals: ${goals.map((g) => g.title).join(", ") || "none"}\nExisting ideas: ${existing.map((e) => e.title).join(", ")}\nToday: ${new Date().toDateString()}`,
  );
  await record(userId, { tokensIn, tokensOut });
  const ideas = (data.ideas ?? []).slice(0, 8);
  if (ideas.length)
    await db
      .insert(ideasTable)
      .values(ideas.map((i) => ({ userId, title: i.title, body: i.body ?? "", prompt: i.prompt, category: i.category ?? "general", emoji: i.emoji ?? "💡" })));
  res.json({ added: ideas.length });
});

router.post("/ideas/:id/start", async (req, res) => {
  const userId = uid(req);
  const [i] = await db
    .select()
    .from(ideasTable)
    .where(and(eq(ideasTable.id, idParam(req)), eq(ideasTable.userId, userId)));
  if (!i) {
    res.status(404).end();
    return;
  }
  // Atomic claim: only the first of several rapid taps starts the idea.
  const claimed = await db
    .update(ideasTable)
    .set({ status: "started" })
    .where(and(eq(ideasTable.id, i.id), ne(ideasTable.status, "started")))
    .returning({ id: ideasTable.id });
  if (!claimed.length) {
    res.json({ ok: true, chatId: await getMainChatId(userId), duplicate: true });
    return;
  }
  const chatId = await getMainChatId(userId);
  await db.insert(messagesTable).values({ userId, chatId, role: "user", content: i.prompt });
  if (activeRunFor(chatId)) steer(chatId, i.prompt);
  else await startRun({ userId, chatId, trigger: "user" });
  res.json({ ok: true, chatId });
});

router.post("/ideas/:id/dismiss", async (req, res) => {
  await db
    .update(ideasTable)
    .set({ status: "dismissed" })
    .where(and(eq(ideasTable.id, idParam(req)), eq(ideasTable.userId, uid(req))));
  res.json({ ok: true });
});

// ---------- workspace files ----------
router.get("/files", async (req, res) => {
  const userId = uid(req);
  if (req.query.path) {
    res.json({ path: req.query.path, content: await readFile(userId, String(req.query.path)) });
    return;
  }
  res.json({ files: await listFiles(userId) });
});

router.put("/files", async (req, res) => {
  const path = String(req.body?.path ?? "");
  if (!path || path.includes("..")) {
    res.status(400).end();
    return;
  }
  await writeFile(uid(req), path, String(req.body?.content ?? ""));
  res.json({ ok: true });
});

router.delete("/files", async (req, res) => {
  const path = String(req.query.path ?? "");
  if (["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"].includes(path)) {
    res.status(400).json({ error: "Core files can't be deleted" });
    return;
  }
  await deleteFile(uid(req), path);
  res.json({ ok: true });
});

// ---------- settings / usage / notifications ----------
router.get("/settings", async (req, res) => {
  const userId = uid(req);
  const [s] = await db.select().from(settingsTable).where(eq(settingsTable.userId, userId));
  const sites = await db.select().from(allowedSitesTable).where(eq(allowedSitesTable.userId, userId));
  const grants = await db.select().from(grantsTable).where(eq(grantsTable.userId, userId));
  res.json({ settings: s, allowedSites: sites, grants: grants.filter((g) => g.scope === "always") });
});

router.patch("/settings", async (req, res) => {
  const patch: Record<string, unknown> = {};
  for (const k of ["connectorDefault", "webDefault", "notifications", "voice", "timezone"]) if (Object.hasOwn(req.body ?? {}, k)) patch[k] = req.body[k];
  if (Object.keys(patch).length)
    await db
      .update(settingsTable)
      .set(patch)
      .where(eq(settingsTable.userId, uid(req)));
  res.json({ ok: true });
});

router.delete("/settings/sites/:id", async (req, res) => {
  const userId = uid(req);
  const [s] = await db
    .select()
    .from(allowedSitesTable)
    .where(and(eq(allowedSitesTable.id, idParam(req)), eq(allowedSitesTable.userId, userId)));
  if (s) {
    await db.delete(allowedSitesTable).where(eq(allowedSitesTable.id, s.id));
    await db.delete(grantsTable).where(and(eq(grantsTable.userId, userId), eq(grantsTable.scope, "site"), eq(grantsTable.target, s.host)));
  }
  res.json({ ok: true });
});

router.delete("/settings/grants/:id", async (req, res) => {
  await db.delete(grantsTable).where(and(eq(grantsTable.id, idParam(req)), eq(grantsTable.userId, uid(req))));
  res.json({ ok: true });
});

router.post("/settings/reset", async (req, res) => {
  const userId = uid(req);
  if (req.body?.confirm !== "RESET") {
    res.status(400).json({ error: "Type RESET to confirm" });
    return;
  }
  for (const t of [
    messagesTable,
    chatsTable,
    workspaceFilesTable,
    activityTable,
    approvalsTable,
    grantsTable,
    goalsTable,
    ideasTable,
    scheduledTasksTable,
    artifactsTable,
    spacesTable,
    connectorsTable,
    credentialsTable,
    mcpServersTable,
    allowedSitesTable,
    notificationsTable,
    runsTable,
    browserSessionsTable,
  ] as any[]) {
    await db.delete(t).where(eq(t.userId, userId));
  }
  await db.delete(agentsTable).where(eq(agentsTable.userId, userId));
  await db.delete(settingsTable).where(eq(settingsTable.userId, userId));
  forgetSetup(userId);
  await ensureUserSetup(userId);
  res.json({ ok: true });
});

router.get("/usage", async (req, res) => {
  const userId = uid(req);
  const history = await db.select().from(usageTable).where(eq(usageTable.userId, userId)).orderBy(desc(usageTable.day)).limit(14);
  res.json({ usage: await getUsage(userId), dailyLimit: DAILY_LIMIT || null, history });
});

router.get("/notifications", async (req, res) => {
  res.json({
    notifications: await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.userId, uid(req)))
      .orderBy(desc(notificationsTable.id))
      .limit(50),
  });
});

router.post("/notifications/read", async (req, res) => {
  await db
    .update(notificationsTable)
    .set({ read: true })
    .where(eq(notificationsTable.userId, uid(req)));
  res.json({ ok: true });
});

router.post("/messages/:id/react", async (req, res) => {
  const userId = uid(req);
  const emoji = String(req.body?.emoji ?? "").slice(0, 8);
  const [m] = await db
    .select()
    .from(messagesTable)
    .where(and(eq(messagesTable.id, idParam(req)), eq(messagesTable.userId, userId)));
  if (!m) {
    res.status(404).end();
    return;
  }
  const parts = ((m.parts as any[]) ?? []).filter((p) => p?.type !== "reaction");
  if (emoji) parts.push({ type: "reaction", emoji });
  const [u] = await db.update(messagesTable).set({ parts }).where(eq(messagesTable.id, m.id)).returning();
  publish(userId, { type: "message", chatId: m.chatId, message: u });
  res.json({ message: u });
});

// ---------- proactive, tracking items & local meeting pipeline ----------
router.get("/proactive/status", async (req, res) => {
  const userId = uid(req);
  const schedules = await db
    .select({ id: scheduledTasksTable.id, kind: scheduledTasksTable.kind, title: scheduledTasksTable.title, enabled: scheduledTasksTable.enabled, intervalMinutes: scheduledTasksTable.intervalMinutes, nextRunAt: scheduledTasksTable.nextRunAt, lastResult: scheduledTasksTable.lastResult })
    .from(scheduledTasksTable)
    .where(eq(scheduledTasksTable.userId, userId));
  const trackingItems = await db.select().from(trackingItemsTable).where(and(eq(trackingItemsTable.userId, userId), eq(trackingItemsTable.status, "open")));
  const deliveries = await db.select().from(proactiveDeliveriesTable).where(eq(proactiveDeliveriesTable.userId, userId)).orderBy(desc(proactiveDeliveriesTable.id)).limit(10);
  const clues = await db.select().from(proactiveCluesTable).where(eq(proactiveCluesTable.userId, userId));
  const [ruleVersion] = await db.select().from(proactiveRuleVersionsTable).where(eq(proactiveRuleVersionsTable.userId, userId)).orderBy(desc(proactiveRuleVersionsTable.version)).limit(1);
  const playbooks = (await listFiles(userId, "skills/proactive/")).map((f) => f.path);
  res.json({
    schedules: schedules.filter((s) => ["heartbeat", "proactive_poll", "proactive_dream", "prep"].includes(s.kind)),
    openTrackingItems: trackingItems.length,
    recentDeliveries: deliveries.length,
    cluesCount: clues.length,
    ruleVersion: ruleVersion?.version ?? 0,
    playbooks,
  });
});

router.get("/tracking-items", async (req, res) => {
  const userId = uid(req);
  const includeClosed = req.query.include_closed === "1" || req.query.include_closed === "true";
  const items = await db
    .select()
    .from(trackingItemsTable)
    .where(includeClosed ? eq(trackingItemsTable.userId, userId) : and(eq(trackingItemsTable.userId, userId), eq(trackingItemsTable.status, "open")))
    .orderBy(desc(trackingItemsTable.id))
    .limit(50);
  res.json({ items });
});

router.post("/tracking-items/:id/done", async (req, res) => {
  const userId = uid(req);
  const id = idParam(req);
  const [existing] = await db.select().from(trackingItemsTable).where(and(eq(trackingItemsTable.id, id), eq(trackingItemsTable.userId, userId)));
  if (!existing) {
    res.status(404).json({ error: "No such tracking item" });
    return;
  }
  const [item] = await db
    .update(trackingItemsTable)
    .set({ status: "done", revision: existing.revision + 1, updatedAt: new Date() })
    .where(eq(trackingItemsTable.id, id))
    .returning();
  await db.update(scheduledTasksTable).set({ enabled: false, lastResult: "Tracking item done" }).where(and(eq(scheduledTasksTable.userId, userId), eq(scheduledTasksTable.trackingItemId, id)));
  res.json({ ok: true, item });
});

router.post("/meetings/ingest", async (req, res) => {
  const userId = uid(req);
  const body = req.body ?? {};
  let transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";

  if (!transcript && typeof body.audioBase64 === "string" && body.audioBase64.trim()) {
    const buf = Buffer.from(body.audioBase64, "base64");
    const mime = typeof body.mimeType === "string" ? body.mimeType : "audio/webm";
    const filename = typeof body.filename === "string" ? body.filename : "meeting.webm";
    const file = new File([buf], filename, { type: mime });
    const tr = await transcribeOpenai.audio.transcriptions.create({ model: MODELS.transcribe, file });
    transcript = tr.text?.trim() ?? "";
  }
  if (!transcript) {
    res.status(400).json({ error: "Either transcript or audioBase64 is required." });
    return;
  }

  const [settings] = await db.select().from(settingsTable).where(eq(settingsTable.userId, userId));
  const tz = settings?.timezone ?? "America/Los_Angeles";
  const date = today(tz);
  let extracted = {
    title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : `Meeting ${date}`,
    summary: transcript.slice(0, 240),
    topics: [] as string[],
    decisions: [] as string[],
    action_items: [] as string[],
  };
  try {
    const r = await jsonCompletion<typeof extracted>(
      'Summarize this meeting transcript into JSON: {"title": string, "summary": string, "topics": string[], "decisions": string[], "action_items": string[]}. Keep action_items concise and concrete.',
      transcript.slice(0, 8000),
    );
    if (r.data) extracted = { ...extracted, ...r.data, title: (typeof body.title === "string" && body.title.trim()) || r.data.title || extracted.title };
  } catch {
    // Fallback uses deterministic summary above
  }

  const slug = slugifyTitle(extracted.title) || `meeting-${Date.now()}`;
  const wikiPath = `wiki/sessions/${date}-${slug}.md`;
  const md = formatMeetingSessionMarkdown({
    date,
    title: extracted.title,
    summary: extracted.summary,
    topics: Array.isArray(extracted.topics) ? extracted.topics : [],
    decisions: Array.isArray(extracted.decisions) ? extracted.decisions : [],
    actionItems: Array.isArray(extracted.action_items) ? extracted.action_items : [],
    transcript,
  });
  await writeFile(userId, wikiPath, md);

  const createdItems = [];
  for (const itemText of (Array.isArray(extracted.action_items) ? extracted.action_items : []).slice(0, 10)) {
    const clean = String(itemText).trim().slice(0, 200);
    if (!clean) continue;
    const [row] = await db.insert(trackingItemsTable).values({ userId, kind: "todo", content: clean, sourceRef: wikiPath }).returning();
    if (row) createdItems.push(row);
  }

  const mainId = await getMainChatId(userId);
  const chatSummary = `**Meeting notes: ${extracted.title}**\n${extracted.summary}${createdItems.length ? `\n\nTracked ${createdItems.length} action item(s).` : ""}`;
  const [msg] = await db.insert(messagesTable).values({ userId, chatId: mainId, role: "assistant", content: chatSummary, proactive: true }).returning();
  publish(userId, { type: "message", chatId: mainId, message: msg });
  publish(userId, { type: "refresh", what: "files" });

  res.json({ ok: true, wikiPath, summary: extracted.summary, trackingItems: createdItems, messageId: msg?.id });
});

router.post("/proactive/poll-now", async (req, res) => {
  const userId = uid(req);
  const [settings] = await db.select().from(settingsTable).where(eq(settingsTable.userId, userId));
  const tz = settings?.timezone ?? "America/Los_Angeles";
  const result = await pollExternalEvents(userId, tz);
  res.json({
    ok: true,
    skipped: result.skipped ?? null,
    unseenCount: result.unseen.length,
    sources: {
      gmail: result.unseen.filter((u) => u.source === "gmail").length,
      calendar: result.unseen.filter((u) => u.source === "calendar").length,
    },
    diagnostics: result.diagnostics ?? [],
  });
});

export default router;
