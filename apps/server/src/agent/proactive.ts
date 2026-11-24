import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import {
  activityTable,
  agentsTable,
  db,
  messagesTable,
  proactiveCluesTable,
  proactiveDeliveriesTable,
  proactiveEventsTable,
  proactiveRuleVersionsTable,
  scheduledTasksTable,
  settingsTable,
  trackingItemsTable,
  workspaceFilesTable,
} from "@amuse/db";
import { jsonCompletion } from "../lib/ai";
import { logger } from "../lib/logger";
import { publish } from "./bus";
import { callRawMcpTool, getMcpState } from "./mcp";
import { appendFile, getMainChatId, readFile, today, writeFile } from "./workspace";

export const MAX_DAILY_PROACTIVE = 5;
export const MAX_CLUES = 20;
export const MAX_RULES = 20;
export const CLUE_TTL_DAYS = 14;

export const PROACTIVE_PLAYBOOKS: Record<string, string> = {
  "skills/proactive/meetings.md": `# Meetings, Interviews & Appointments

- **Tracking:** Record \`kind: "meeting"\` with exact \`due_at\` and \`source_ref\`. Check for clashes against other open tracking items.
- **Prep:** Schedule a \`prep\` check 12-18h before interviews, first meetings, pitches, or client/partner calls. Look up prior emails, \`wiki/\` pages, and web background; deliver one short briefing + Artifact/PDF link.
- **Tell:** Only notify if it is today, needs prep now, or its time/location/attendees changed. Otherwise stay silent.
`,
  "skills/proactive/occasions.md": `# Birthdays, Anniversaries & Occasions

- **Tracking:** Record \`kind: "todo"\` or \`"meeting"\` with the date and person's name.
- **Prep:** Remind 5-7 days ahead when gifts, reservations, or cards are needed, and again the morning of the occasion.
- **Tell:** Keep it brief with 1-2 concrete options (gift/venue) checked against current availability.
`,
  "skills/proactive/travel.md": `# Flights, Trains & Trips

- **Tracking:** Record \`kind: "meeting"\` for departures/check-ins. Keep the item open until the trip finishes.
- **Prep:** For multi-day trips, maintain one itinerary Artifact/Space. Day-before reminder should cover departure time, connection, and airport transit.
- **Tell:** Notify immediately on cancellations, major delays, gate changes, or check-in windows opening.
`,
  "skills/proactive/commitments.md": `# Todos, Deadlines, Promises & Replies

- **Tracking:** Record \`kind: "todo"\` (user owes action/reply) or \`"question"\` (waiting on someone else).
- **Follow-up:** Escalate check frequency as \`due_at\` approaches; mark \`tracking_done\` once resolved or replied.
- **Tell:** Notify when a reply arrives for an open \`question\`, a deadline is today/slipping, or a newly spotted email answers an open item.
`,
};

export function parseQuietWindow(prefsText: string): { startHour: number; endHour: number } {
  const m = prefsText.match(/(\d{1,2}):\d{2}\s*(?:to|-|–|—)\s*(\d{1,2}):\d{2}/i);
  if (m) {
    const activeStart = Math.max(0, Math.min(23, Number(m[1])));
    const activeEnd = Math.max(0, Math.min(23, Number(m[2])));
    if (Number.isFinite(activeStart) && Number.isFinite(activeEnd) && activeStart !== activeEnd) {
      return { startHour: activeEnd, endHour: activeStart };
    }
  }
  return { startHour: 22, endHour: 8 };
}

export function isQuietHour(now: Date, tz: string, prefsText = ""): boolean {
  const { startHour, endHour } = parseQuietWindow(prefsText);
  const hourStr = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now);
  const hour = Number(hourStr) % 24;
  if (startHour > endHour) return hour >= startHour || hour < endHour;
  return hour >= startHour && hour < endHour;
}

export async function isChatQuiet(userId: string, activeRunRunning: boolean, minQuietMs = 180_000): Promise<boolean> {
  if (activeRunRunning) return false;
  const mainId = await getMainChatId(userId);
  const [lastUserMsg] = await db
    .select({ createdAt: messagesTable.createdAt })
    .from(messagesTable)
    .where(and(eq(messagesTable.userId, userId), eq(messagesTable.chatId, mainId), eq(messagesTable.role, "user")))
    .orderBy(desc(messagesTable.id))
    .limit(1);
  if (!lastUserMsg) return true;
  return Date.now() - lastUserMsg.createdAt.getTime() >= minQuietMs;
}

export async function dailyProactiveCount(userId: string, tz: string): Promise<number> {
  const day = today(tz);
  const since = new Date(Date.now() - 36 * 3600_000);
  const rows = await db
    .select({ createdAt: proactiveDeliveriesTable.createdAt })
    .from(proactiveDeliveriesTable)
    .where(and(eq(proactiveDeliveriesTable.userId, userId), gte(proactiveDeliveriesTable.createdAt, since)));
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return rows.filter((r) => fmt.format(r.createdAt) === day).length;
}

export async function canDeliverProactive(
  userId: string,
  tz: string,
  activeRunRunning: boolean,
  urgent = false,
): Promise<{ allowed: boolean; reason?: string }> {
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
  if (agent?.proactivity === "off") return { allowed: false, reason: "proactivity_off" };
  if (!(await isChatQuiet(userId, activeRunRunning))) return { allowed: false, reason: "chat_active" };
  if (!urgent) {
    const prefs = (await readFile(userId, "PROACTIVE_PREFERENCES.md")) ?? "";
    if (isQuietHour(new Date(), tz, prefs)) return { allowed: false, reason: "quiet_hours" };
    if ((await dailyProactiveCount(userId, tz)) >= MAX_DAILY_PROACTIVE) return { allowed: false, reason: "daily_cap" };
  }
  return { allowed: true };
}

export async function recordProactiveDelivery(
  userId: string,
  source: string,
  messageId: number,
  summary: string,
  trackingItemId?: number | null,
) {
  await db.insert(proactiveDeliveriesTable).values({
    userId,
    source,
    messageId,
    trackingItemId: trackingItemId ?? null,
    summary: summary.slice(0, 500),
  });
}

export function eventStateHash(item: unknown): string {
  const norm = JSON.stringify(item ?? null);
  return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

export async function pollExternalEvents(
  userId: string,
  tz: string,
): Promise<{
  skipped?: string;
  unseen: Array<{ source: "gmail" | "calendar"; externalKey: string; summary: string; payload: Record<string, unknown> }>;
  diagnostics?: Array<{ source: "gmail" | "calendar"; account: string; count: number; error?: string }>;
}> {
  const mcpState = await getMcpState(userId).catch(() => null);
  const composio = mcpState ? Array.from(mcpState.servers.values()).find((s) => s.name.toLowerCase() === "composio") : undefined;
  if (!composio || composio.offeredInfos.length === 0) {
    return { skipped: "composio_offline", unseen: [] };
  }

  const dayKey = today(tz);
  const unseen: Array<{ source: "gmail" | "calendar"; externalKey: string; summary: string; payload: Record<string, unknown> }> = [];
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + 48 * 3600_000).toISOString();

  try {
    let sessionId: string | undefined;
    const sr = await callRawMcpTool(
      "composio",
      "COMPOSIO_SEARCH_TOOLS",
      { queries: [{ use_case: "fetch recent emails and list google calendar events" }], session: { generate_id: true } },
      userId,
    ).catch(() => null);
    sessionId = (sr?.parsed as any)?.data?.session?.id as string | undefined;

    const mc = await callRawMcpTool(
      "composio",
      "COMPOSIO_MANAGE_CONNECTIONS",
      { toolkits: [{ name: "gmail", action: "list" }, { name: "googlecalendar", action: "list" }] },
      userId,
    ).catch(() => null);
    const connResults = (mc?.parsed as any)?.data?.results ?? {};
    const activeAccounts = (raw: unknown, max: number): Array<{ accountArg: string; label: string }> => {
      const list = Array.isArray(raw) ? raw : [];
      const active = list.filter((a: any) => !a?.status || String(a.status).toUpperCase() === "ACTIVE");
      const pool = active.length ? active : list;
      return pool
        .map((a: any) => {
          const accountArg = String(a?.alias || a?.id || "").trim();
          const label = String(a?.user_info?.email || a?.alias || a?.id || "").trim();
          return { accountArg, label };
        })
        .filter((x) => !!x.accountArg)
        .slice(0, max);
    };

    const gmailAccounts = activeAccounts(connResults.gmail?.accounts, 7);
    const calAccounts = activeAccounts(connResults.googlecalendar?.accounts, 5);
    const calls: Array<{ meta: { source: "gmail" | "calendar"; account: string }; tool: Record<string, unknown> }> = [];

    for (const acc of gmailAccounts.length ? gmailAccounts : [{ accountArg: "", label: "default" }]) {
      calls.push({
        meta: { source: "gmail", account: acc.label },
        tool: {
          tool_slug: "GMAIL_FETCH_EMAILS",
          arguments: { query: "newer_than:2d -in:sent -category:promotions", max_results: 5 },
          ...(acc.accountArg ? { account: acc.accountArg } : {}),
        },
      });
    }
    for (const acc of calAccounts.length ? calAccounts : [{ accountArg: "", label: "default" }]) {
      calls.push({
        meta: { source: "calendar", account: acc.label },
        tool: {
          tool_slug: "GOOGLECALENDAR_EVENTS_LIST",
          arguments: { calendarId: "primary", timeMin, timeMax, singleEvents: true, maxResults: 10 },
          ...(acc.accountArg ? { account: acc.accountArg } : {}),
        },
      });
    }

    const diagnostics: Array<{ source: "gmail" | "calendar"; account: string; count: number; error?: string }> = [];
    // Execute in small batches of 3 so Composio Tool Router never drops trailing items or hits batch limits.
    const BATCH = 3;
    for (let b = 0; b < calls.length; b += BATCH) {
      const slice = calls.slice(b, b + BATCH);
      const res = await callRawMcpTool(
        "composio",
        "COMPOSIO_MULTI_EXECUTE_TOOL",
        {
          tools: slice.map((c) => c.tool),
          sync_response_to_workbench: false,
          ...(sessionId ? { session_id: sessionId } : {}),
          thought: "Poll connected Gmail and Google Calendar accounts for unseen proactive events",
          current_step: "PROACTIVE_POLL",
          current_step_metric: `${Math.floor(b / BATCH) + 1}/${Math.ceil(calls.length / BATCH)}`,
        },
        userId,
      );
      if (res.isError || (res.parsed as any)?.successful === false) {
        logger.warn({ error: (res.parsed as any)?.error ?? res.text.slice(0, 400), userId }, "proactive external poll returned error");
      }
      const results: any[] = (res.parsed as any)?.data?.results ?? [];
      for (let i = 0; i < slice.length; i++) {
        const meta = slice[i]!.meta;
        const itemErr = results[i]?.error ?? results[i]?.response?.error ?? (results[i]?.response?.successful === false ? "failed" : undefined);
        const data = results[i]?.response?.data ?? results[i]?.response?.data_preview ?? results[i]?.data ?? {};
        if (meta.source === "gmail") {
          const messages: any[] = data.messages ?? data.threads ?? [];
          diagnostics.push({ source: "gmail", account: meta.account, count: messages.length, ...(itemErr ? { error: String(itemErr).slice(0, 120) } : {}) });
          for (const m of messages.slice(0, 5)) {
            const id = String(m.messageId ?? m.id ?? m.threadId ?? "");
            if (!id) continue;
            const subject = String(m.subject ?? m.snippet ?? "").slice(0, 140);
            const from = String(m.sender ?? m.from ?? "").slice(0, 80);
            const extKey = `${meta.account}:${id}`;
            const stateHash = eventStateHash({ account: meta.account, id, subject, from, labelIds: m.labelIds ?? [] });
            const inserted = await db
              .insert(proactiveEventsTable)
              .values({ userId, source: "gmail", externalKey: extKey, stateHash, dayKey, status: "seen", payload: { account: meta.account, id, subject, from } })
              .onConflictDoNothing()
              .returning({ id: proactiveEventsTable.id });
            if (inserted.length > 0) {
              unseen.push({
                source: "gmail",
                externalKey: extKey,
                summary: `[${meta.account}] Email from ${from || "unknown"}: ${subject || "(no subject)"}`,
                payload: { account: meta.account, id, subject, from },
              });
            }
          }
        } else {
          const events: any[] = data.items ?? data.events ?? [];
          diagnostics.push({ source: "calendar", account: meta.account, count: events.length, ...(itemErr ? { error: String(itemErr).slice(0, 120) } : {}) });
          for (const ev of events.slice(0, 10)) {
            const id = String(ev.id ?? "");
            if (!id) continue;
            const summary = String(ev.summary ?? "(untitled event)").slice(0, 140);
            const start = String(ev.start?.dateTime ?? ev.start?.date ?? "");
            const status = String(ev.status ?? "confirmed");
            const extKey = `${meta.account}:${id}`;
            const stateHash = eventStateHash({ account: meta.account, id, summary, start, status, updated: ev.updated ?? "" });
            const inserted = await db
              .insert(proactiveEventsTable)
              .values({ userId, source: "calendar", externalKey: extKey, stateHash, dayKey, status: "seen", payload: { account: meta.account, id, summary, start, status } })
              .onConflictDoNothing()
              .returning({ id: proactiveEventsTable.id });
            if (inserted.length > 0) {
              unseen.push({
                source: "calendar",
                externalKey: extKey,
                summary: `[${meta.account}] Calendar (${status}) @ ${start}: ${summary}`,
                payload: { account: meta.account, id, summary, start, status },
              });
            }
          }
        }
      }
    }
    logger.info({ userId, diagnostics }, "proactive external poll summary");
    return { unseen, diagnostics };
  } catch (err) {
    logger.warn({ err, userId }, "proactive external event poll failed");
  }

  return { unseen };
}

export async function checkChatReviewDue(userId: string): Promise<{ due: boolean; windowText?: string; lastMsgId?: number }> {
  const mainId = await getMainChatId(userId);
  const [cursor] = await db
    .select()
    .from(proactiveEventsTable)
    .where(and(eq(proactiveEventsTable.userId, userId), eq(proactiveEventsTable.source, "chat_review_cursor")))
    .orderBy(desc(proactiveEventsTable.id))
    .limit(1);
  const afterId = Number((cursor?.payload as any)?.lastMsgId ?? 0);
  const recent = await db
    .select({ id: messagesTable.id, role: messagesTable.role, content: messagesTable.content })
    .from(messagesTable)
    .where(and(eq(messagesTable.userId, userId), eq(messagesTable.chatId, mainId), gte(messagesTable.id, afterId + 1)))
    .orderBy(asc(messagesTable.id))
    .limit(25);
  const userOrAssistant = recent.filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim());
  if (userOrAssistant.length < 20) return { due: false };
  const lastMsgId = userOrAssistant[userOrAssistant.length - 1]!.id;
  await db
    .insert(proactiveEventsTable)
    .values({
      userId,
      source: "chat_review_cursor",
      externalKey: `main:${lastMsgId}`,
      stateHash: String(lastMsgId),
      dayKey: today("America/Los_Angeles"),
      status: "judged",
      payload: { lastMsgId },
    })
    .onConflictDoNothing();
  const windowText = userOrAssistant
    .slice(-20)
    .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
    .join("\n");
  return { due: true, windowText, lastMsgId };
}

export function nextLocalTimeUtc(hour: number, minute: number, tz: string, now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  const offsetMs = localAsUtc - now.getTime();
  let targetUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, minute, 0) - offsetMs;
  if (targetUtc <= now.getTime()) targetUtc += 86400_000;
  return new Date(targetUtc);
}

export async function ensureProactiveSetup(userId: string) {
  for (const [path, content] of Object.entries(PROACTIVE_PLAYBOOKS)) {
    const existing = await readFile(userId, path);
    if (existing === null) await writeFile(userId, path, content);
  }
  const tasks = await db.select().from(scheduledTasksTable).where(eq(scheduledTasksTable.userId, userId));
  const kinds = new Set(tasks.map((t) => t.kind));
  if (!kinds.has("proactive_poll")) {
    await db.insert(scheduledTasksTable).values({
      userId,
      kind: "proactive_poll",
      title: "Proactive inbox & calendar watch",
      prompt: "Review newly detected inbox/calendar events or recent chat window against open tracking items and PROACTIVE_PREFERENCES.md.",
      intervalMinutes: 10,
      nextRunAt: new Date(Date.now() + 10 * 60_000),
      enabled: true,
    });
  }
  if (!kinds.has("proactive_dream")) {
    const [settings] = await db.select().from(settingsTable).where(eq(settingsTable.userId, userId));
    const tz = settings?.timezone ?? "America/Los_Angeles";
    const nextDream = nextLocalTimeUtc(2, 30, tz);
    await db.insert(scheduledTasksTable).values({
      userId,
      kind: "proactive_dream",
      title: "Nightly proactive dreaming & wiki consolidation",
      prompt: "Nightly dreaming and wiki/report consolidation.",
      intervalMinutes: 1440,
      nextRunAt: nextDream,
      enabled: true,
    });
  }
}

/** Fast <15ms Postgres FTS recall injected into <live_state> (preserves static prefix cache). */
export async function buildFlashback(userId: string, userText: string): Promise<string> {
  const clean = userText.replace(/[^\w\s-]/g, " ").trim().slice(0, 160);
  if (clean.length < 4) return "";
  try {
    const res = await db.execute(sql`
      SELECT path, left(content, 240) AS snippet
      FROM workspace_files
      WHERE user_id = ${userId}
        AND (path LIKE 'wiki/%' OR path LIKE 'reports/%' OR path = 'MEMORY.md')
        AND to_tsvector('english', content) @@ websearch_to_tsquery('english', ${clean})
      ORDER BY ts_rank_cd(to_tsvector('english', content), websearch_to_tsquery('english', ${clean})) DESC
      LIMIT 3
    `);
    const rows = (res.rows ?? []) as Array<{ path: string; snippet: string }>;
    if (!rows.length) return "";
    return rows.map((r) => `[${r.path}] ${String(r.snippet).replace(/\s+/g, " ").trim()}`).join("\n").slice(0, 700);
  } catch {
    return "";
  }
}

export type ClueRecord = {
  matter: string;
  kind: string;
  timeWindow: string | null;
  leaning: "tell_now" | "follow_up_later" | "stay_silent";
  seen: number;
  lastSeenAt: Date;
};

export function mergeCluesAndPromote(
  existingClues: ClueRecord[],
  extracted: Array<{ matter: string; kind: string; timeWindow?: string | null; leaning: "tell_now" | "follow_up_later" | "stay_silent" }>,
  existingRules: string[],
  now = new Date(),
): { clues: ClueRecord[]; rules: string[]; promoted: string[] } {
  const cutoff = now.getTime() - CLUE_TTL_DAYS * 86400_000;
  const active = existingClues.filter((c) => c.lastSeenAt.getTime() >= cutoff).map((c) => ({ ...c }));
  const promoted: string[] = [];
  const rules = [...existingRules];

  for (const item of extracted) {
    const keyKind = item.kind.trim().toLowerCase();
    const match = active.find((c) => c.kind.toLowerCase() === keyKind && c.leaning === item.leaning);
    if (match) {
      match.seen += 1;
      match.lastSeenAt = now;
      match.matter = item.matter;
    } else {
      active.push({
        matter: item.matter,
        kind: item.kind,
        timeWindow: item.timeWindow ?? null,
        leaning: item.leaning,
        seen: 1,
        lastSeenAt: now,
      });
    }
  }

  const remaining: ClueRecord[] = [];
  for (const c of active) {
    if (c.seen >= 2) {
      const actionLabel = c.leaning === "tell_now" ? "Tell now" : c.leaning === "stay_silent" ? "Stay silent" : "Follow up later";
      const ruleText = `${c.kind}${c.timeWindow ? ` (${c.timeWindow})` : ""} -> ${actionLabel}`;
      if (!rules.includes(ruleText)) {
        rules.push(ruleText);
        promoted.push(ruleText);
      }
    } else {
      remaining.push(c);
    }
  }

  remaining.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  return { clues: remaining.slice(0, MAX_CLUES), rules: rules.slice(-MAX_RULES), promoted };
}

export function renderLearnedRulesIntoPreferences(prefsText: string, rules: string[]): string {
  const body = rules.length ? rules.map((r) => `- ${r}`).join("\n") : "- (None learned yet.)";
  const section = `## Learned Rules\n${body}\n`;
  if (/^## Learned Rules\b/m.test(prefsText)) {
    return prefsText.replace(/^## Learned Rules[\s\S]*?(?=\n## |$)/m, section.trimEnd());
  }
  return prefsText.trimEnd() + "\n\n" + section;
}

export async function runProactiveDreaming(userId: string, tz: string) {
  const undreamed = await db
    .select()
    .from(proactiveDeliveriesTable)
    .where(and(eq(proactiveDeliveriesTable.userId, userId), isNull(proactiveDeliveriesTable.dreamedAt)))
    .orderBy(asc(proactiveDeliveriesTable.id))
    .limit(10);
  if (!undreamed.length) return { dreamed: 0, promoted: 0 };

  const mainId = await getMainChatId(userId);
  const exchanges: string[] = [];
  for (const d of undreamed) {
    const replies = await db
      .select({ role: messagesTable.role, content: messagesTable.content })
      .from(messagesTable)
      .where(and(eq(messagesTable.userId, userId), eq(messagesTable.chatId, mainId), gte(messagesTable.id, d.messageId)))
      .orderBy(asc(messagesTable.id))
      .limit(10);
    exchanges.push(`[${d.source}] ${d.summary}\nReplies:\n` + replies.map((r) => `${r.role}: ${r.content.slice(0, 200)}`).join("\n"));
  }

  let extracted: Array<{ matter: string; kind: string; timeWindow?: string | null; leaning: "tell_now" | "follow_up_later" | "stay_silent" }> = [];
  try {
    const r = await jsonCompletion<{ clues: typeof extracted }>(
      'Analyze how the user reacted to proactive messages. Extract ONLY explicit timing/topic feedback (e.g. "tell me sooner", "too late at night", "stop reminding me about X"). Reply with JSON {"clues": [{"matter": string, "kind": string, "timeWindow": string|null, "leaning": "tell_now"|"follow_up_later"|"stay_silent"}]}. Return {"clues":[]} if neutral or no feedback.',
      exchanges.join("\n---\n").slice(0, 6000),
    );
    if (Array.isArray(r.data?.clues)) extracted = r.data.clues;
  } catch {
    extracted = [];
  }

  const dbClues = await db.select().from(proactiveCluesTable).where(eq(proactiveCluesTable.userId, userId));
  const [latestRuleVer] = await db
    .select()
    .from(proactiveRuleVersionsTable)
    .where(eq(proactiveRuleVersionsTable.userId, userId))
    .orderBy(desc(proactiveRuleVersionsTable.version))
    .limit(1);

  const merged = mergeCluesAndPromote(
    dbClues.map((c) => ({
      matter: c.matter,
      kind: c.kind,
      timeWindow: c.timeWindow,
      leaning: c.leaning as "tell_now" | "follow_up_later" | "stay_silent",
      seen: c.seen,
      lastSeenAt: c.lastSeenAt,
    })),
    extracted,
    latestRuleVer?.rules ?? [],
  );

  await db.delete(proactiveCluesTable).where(eq(proactiveCluesTable.userId, userId));
  if (merged.clues.length) {
    await db.insert(proactiveCluesTable).values(
      merged.clues.map((c) => ({
        userId,
        matter: c.matter,
        kind: c.kind,
        timeWindow: c.timeWindow,
        leaning: c.leaning,
        seen: c.seen,
        lastSeenAt: c.lastSeenAt,
      })),
    );
  }
  if (merged.promoted.length) {
    const nextVer = (latestRuleVer?.version ?? 0) + 1;
    await db.insert(proactiveRuleVersionsTable).values({
      userId,
      version: nextVer,
      rules: merged.rules,
      rationale: `Promoted ${merged.promoted.length} rule(s) on ${today(tz)}`,
    });
    const prefs = (await readFile(userId, "PROACTIVE_PREFERENCES.md")) ?? "# PROACTIVE_PREFERENCES.md\n";
    await writeFile(userId, "PROACTIVE_PREFERENCES.md", renderLearnedRulesIntoPreferences(prefs, merged.rules));
  }

  for (const d of undreamed) {
    await db.update(proactiveDeliveriesTable).set({ dreamedAt: new Date() }).where(eq(proactiveDeliveriesTable.id, d.id));
  }
  return { dreamed: undreamed.length, promoted: merged.promoted.length };
}

export async function runNightlyConsolidation(userId: string, tz: string) {
  const day = today(tz);
  const since = new Date(Date.now() - 24 * 3600_000);
  const msgs = await db
    .select({ role: messagesTable.role, content: messagesTable.content })
    .from(messagesTable)
    .where(and(eq(messagesTable.userId, userId), gte(messagesTable.createdAt, since)))
    .orderBy(asc(messagesTable.id))
    .limit(60);
  const acts = await db
    .select({ summary: activityTable.summary })
    .from(activityTable)
    .where(and(eq(activityTable.userId, userId), gte(activityTable.createdAt, since)))
    .orderBy(asc(activityTable.id))
    .limit(30);
  if (!msgs.length && !acts.length) return { wroteReport: false };

  const transcript = [
    ...msgs.filter((m) => m.content.trim()).map((m) => `${m.role}: ${m.content.slice(0, 250)}`),
    ...acts.map((a) => `[activity] ${a.summary}`),
  ]
    .join("\n")
    .slice(0, 6000);

  let report = { summary: "Quiet day.", highlights: [] as string[], durable_facts: [] as string[], entities: [] as Array<{ type: string; name: string; note: string }> };
  try {
    const r = await jsonCompletion<typeof report>(
      'Consolidate the last 24h into JSON: {"summary": string, "highlights": string[], "durable_facts": string[], "entities": [{"type": "clients"|"contacts"|"projects"|"topics", "name": string, "note": string}]}. Keep facts concise and skip ephemeral chatter.',
      transcript,
    );
    if (r.data) report = { ...report, ...r.data };
  } catch {
    report.summary = `Activity summary for ${day}: ${msgs.length} messages, ${acts.length} actions.`;
  }

  const dailyMd = `# Daily Report — ${day}\n\n${report.summary}\n\n## Highlights\n${(report.highlights ?? []).map((h) => `- ${h}`).join("\n") || "- None"}\n`;
  await writeFile(userId, `reports/daily/${day}.md`, dailyMd);

  for (const fact of (report.durable_facts ?? []).slice(0, 5)) {
    const curMem = (await readFile(userId, "MEMORY.md")) ?? "";
    if (fact && !curMem.includes(fact)) await appendFile(userId, "MEMORY.md", `- ${fact}`);
  }
  for (const ent of (report.entities ?? []).slice(0, 5)) {
    const dir = ["clients", "contacts", "projects", "topics"].includes(ent.type) ? ent.type : "topics";
    const slug = slugifyTitle(ent.name);
    if (!slug) continue;
    const wikiPath = `wiki/${dir}/${slug}.md`;
    const cur = (await readFile(userId, wikiPath)) ?? `# ${ent.name}\n\n## Notes\n\n## Change Log\n`;
    const updated = cur.includes("## Change Log")
      ? cur.replace("## Change Log", `## Change Log\n- ${day}: ${ent.note}`)
      : cur.trimEnd() + `\n\n## Change Log\n- ${day}: ${ent.note}\n`;
    await writeFile(userId, wikiPath, updated);
  }
  publish(userId, { type: "refresh", what: "files" });
  return { wroteReport: true, path: `reports/daily/${day}.md` };
}

export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function formatMeetingSessionMarkdown(input: {
  date: string;
  title: string;
  summary: string;
  topics: string[];
  decisions: string[];
  actionItems: string[];
  transcript: string;
}): string {
  return [
    `# ${input.title}`,
    `Date: ${input.date}`,
    "",
    "## Summary",
    input.summary,
    "",
    "## Topics",
    input.topics.length ? input.topics.map((t) => `- ${t}`).join("\n") : "- None",
    "",
    "## Decisions",
    input.decisions.length ? input.decisions.map((d) => `- ${d}`).join("\n") : "- None",
    "",
    "## Action Items",
    input.actionItems.length ? input.actionItems.map((a) => `- [ ] ${a}`).join("\n") : "- None",
    "",
    "## Transcript",
    input.transcript.slice(0, 12000),
    "",
    "## Change Log",
    `- ${input.date}: Ingested local meeting session.`,
    "",
  ].join("\n");
}
