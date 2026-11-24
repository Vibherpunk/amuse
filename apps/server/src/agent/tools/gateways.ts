import { and, eq, ilike } from "drizzle-orm";
import { db, workspaceFilesTable } from "@amuse/db";
import { windmillWorkspace } from "../../lib/config";
import type { ConnectedMcpServer, McpRegistryState } from "../mcp";
import { callRawMcpTool } from "../mcp";
import { validateArgs } from "../robustness";
import { check, markUntrustedRead } from "../sentinel";
import { listFiles } from "../workspace";
import { browserTools } from "./browser";
import { codeTools } from "./code";
import { connectorTools } from "./connectors";
import { docTools, makerTools, memoryTools, planningTools, spaceTools, trackingTools } from "./internal";
import { mediaTools } from "./media";
import { memorySearchTool, searchPattern } from "./memory";
import { terminalTools } from "./terminal";
import { num, obj, str, type ToolContext, type ToolDef } from "./types";
import { webTools } from "./web";
import { windmillTools } from "./windmill";

function byNameMap(defs: ToolDef[]): Map<string, ToolDef> {
  return new Map(defs.map((d) => [d.name, d]));
}

const INTERNAL_MAP = byNameMap([
  ...webTools,
  ...browserTools,
  ...memoryTools,
  memorySearchTool,
  ...planningTools,
  ...makerTools,
  ...spaceTools,
  ...mediaTools,
  ...terminalTools,
  ...windmillTools,
  ...codeTools,
  ...connectorTools,
]);

function mustTool(name: string): ToolDef {
  const t = INTERNAL_MAP.get(name);
  if (!t) throw new Error(`Missing underlying tool: ${name}`);
  return t;
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function parseJsonObj(val: unknown, fieldName: string): { value?: Record<string, unknown>; error?: string } {
  if (val === undefined || val === null) return {};
  if (typeof val === "object" && !Array.isArray(val)) return { value: val as Record<string, unknown> };
  if (typeof val === "string") {
    const s = val.trim();
    if (!s) return {};
    try {
      const parsed = JSON.parse(s);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: `${fieldName} must decode to a JSON object` };
      }
      return { value: parsed as Record<string, unknown> };
    } catch {
      return { error: `${fieldName} is not valid JSON` };
    }
  }
  return { error: `${fieldName} must be a JSON object string` };
}

function parseJsonArray(val: unknown, fieldName: string): { value?: unknown[]; error?: string } {
  if (val === undefined || val === null) return {};
  if (Array.isArray(val)) return { value: val };
  if (typeof val === "string") {
    const s = val.trim();
    if (!s) return {};
    try {
      const parsed = JSON.parse(s);
      if (!Array.isArray(parsed)) return { error: `${fieldName} must decode to a JSON array` };
      return { value: parsed };
    } catch {
      return { error: `${fieldName} is not valid JSON` };
    }
  }
  return { error: `${fieldName} must be a JSON array string` };
}

function pickSchemaKeys(merged: Record<string, unknown>, schema: Record<string, unknown>): Record<string, unknown> {
  const props = ((schema as any)?.properties ?? {}) as Record<string, unknown>;
  const allowed = new Set(Object.keys(props));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined && allowed.has(k)) out[k] = v;
  }
  return out;
}

function findMcpServer(state: McpRegistryState, name: string): ConnectedMcpServer | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of state.servers.entries()) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

// ---------- 1. terminal_run (unchanged) ----------
export const gatewayTerminalTool: ToolDef = mustTool("terminal_run");

// ---------- 2. files gateway ----------
export const filesGatewayTool: ToolDef = {
  name: "files",
  skill: "Files",
  status: "Working with files",
  description:
    "Manage your workspace files (SOUL.md, USER.md, MEMORY.md, AGENTS.md, files/...): read, write (exact content), delete, list, or search text across workspace files.",
  parameters: obj(
    {
      action: { type: "string", enum: ["read", "write", "delete", "list", "search"], description: "File operation" },
      path: str("Workspace file path (for read/write/delete) or optional prefix (for list)"),
      content: str("Exact file content (for write)"),
      query: str("Literal text to search for across workspace files (for search)"),
    },
    ["action"],
  ),
  async run(a, ctx) {
    const action = String(a.action);
    if (action === "read") {
      if (typeof a.path !== "string" || !a.path) return { error: "path is required for read" };
      return mustTool("read_file").run({ path: a.path }, ctx);
    }
    if (action === "write") {
      if (typeof a.path !== "string" || !a.path) return { error: "path is required for write" };
      if (typeof a.content !== "string") return { error: "content must be a string for write" };
      return mustTool("write_file").run({ path: a.path, content: a.content }, ctx);
    }
    if (action === "delete") {
      if (typeof a.path !== "string" || !a.path) return { error: "path is required for delete" };
      return mustTool("delete_file").run({ path: a.path }, ctx);
    }
    if (action === "list") {
      const prefix = typeof a.path === "string" && a.path ? a.path : undefined;
      return { files: await listFiles(ctx.userId, prefix) };
    }
    if (action === "search") {
      const q = String(a.query ?? "").trim();
      if (!q) return { error: "query is required for search" };
      if ((await check({ ...ctx, toolName: "memory_search", actionClass: "read", purpose: "Search workspace files" })) !== "allow") {
        return { error: "The person denied searching workspace files." };
      }
      const pattern = searchPattern(q);
      const rows = await db
        .select({ path: workspaceFilesTable.path, content: workspaceFilesTable.content })
        .from(workspaceFilesTable)
        .where(and(eq(workspaceFilesTable.userId, ctx.userId), ilike(workspaceFilesTable.content, pattern)))
        .limit(15);
      const excerpt = (content: string) => {
        const i = content.toLowerCase().indexOf(q.toLowerCase());
        return content.slice(Math.max(0, i - 200), Math.max(0, i - 200) + 1600);
      };
      return {
        untrusted_data: true,
        matches: rows.map((r) => ({ path: r.path, content: excerpt(r.content) })),
      };
    }
    return { error: `Unknown files action: ${action}` };
  },
};

// ---------- 3. web gateway ----------
export const webGatewayTool: ToolDef = {
  name: "web",
  skill: "Web browsing",
  status: "Using the web",
  description:
    "Search the web (search), fetch a page or JSON endpoint (fetch), drive the live browser for multi-step interactive tasks (browse), or check weather for a city (weather).",
  parameters: obj(
    {
      action: { type: "string", enum: ["search", "fetch", "browse", "weather"], description: "Web operation" },
      query: str("Search query (for search)"),
      url: str("Absolute http(s) URL (for fetch, or optional start_url for browse)"),
      goal: str("Multi-step browsing task goal (for browse)"),
      place: str("City or region name, e.g. 'Seattle, WA' (for weather)"),
    },
    ["action"],
  ),
  async run(a, ctx) {
    const action = String(a.action);
    if (action === "search") {
      if (!String(a.query ?? "").trim()) return { error: "query is required for search" };
      return mustTool("web_search").run({ query: String(a.query) }, ctx);
    }
    if (action === "fetch") {
      if (!String(a.url ?? "").trim()) return { error: "url is required for fetch" };
      return mustTool("web_fetch").run({ url: String(a.url) }, ctx);
    }
    if (action === "browse") {
      if (!String(a.goal ?? "").trim()) return { error: "goal is required for browse" };
      return mustTool("browser_task").run(stripUndefined({ goal: String(a.goal), start_url: a.url ? String(a.url) : undefined }), ctx);
    }
    if (action === "weather") {
      if (!String(a.place ?? "").trim()) return { error: "place is required for weather" };
      return mustTool("weather").run({ place: String(a.place) }, ctx);
    }
    return { error: `Unknown web action: ${action}` };
  },
};

// ---------- 4. google gateway (Composio server-side orchestration) ----------
type GoogleActionSpec = {
  toolkit: "gmail" | "googlecalendar";
  slug: string;
  useCase: string;
  actionClass: "read" | "write" | "send";
  forceAsk: boolean;
};

const GOOGLE_ACTIONS: Record<string, GoogleActionSpec> = {
  gmail_search: { toolkit: "gmail", slug: "GMAIL_FETCH_EMAILS", useCase: "search emails in gmail", actionClass: "read", forceAsk: false },
  gmail_read: {
    toolkit: "gmail",
    slug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    useCase: "read email message by id in gmail",
    actionClass: "read",
    forceAsk: false,
  },
  gmail_labels: { toolkit: "gmail", slug: "GMAIL_LIST_LABELS", useCase: "list gmail labels", actionClass: "read", forceAsk: false },
  gmail_draft: { toolkit: "gmail", slug: "GMAIL_CREATE_EMAIL_DRAFT", useCase: "create email draft in gmail", actionClass: "write", forceAsk: false },
  gmail_send: { toolkit: "gmail", slug: "GMAIL_SEND_EMAIL", useCase: "send an email in gmail", actionClass: "send", forceAsk: true },
  gmail_reply: { toolkit: "gmail", slug: "GMAIL_REPLY_TO_THREAD", useCase: "reply to an email thread in gmail", actionClass: "send", forceAsk: true },
  calendar_list: { toolkit: "googlecalendar", slug: "GOOGLECALENDAR_EVENTS_LIST", useCase: "list google calendar events", actionClass: "read", forceAsk: false },
  calendar_get: { toolkit: "googlecalendar", slug: "GOOGLECALENDAR_EVENTS_GET", useCase: "get google calendar event details", actionClass: "read", forceAsk: false },
  calendar_calendars: { toolkit: "googlecalendar", slug: "GOOGLECALENDAR_LIST_CALENDARS", useCase: "list google calendars", actionClass: "read", forceAsk: false },
  calendar_free_slots: { toolkit: "googlecalendar", slug: "GOOGLECALENDAR_FIND_FREE_SLOTS", useCase: "find free slots in google calendar", actionClass: "read", forceAsk: false },
  calendar_create: { toolkit: "googlecalendar", slug: "GOOGLECALENDAR_CREATE_EVENT", useCase: "create event in google calendar", actionClass: "write", forceAsk: false },
  calendar_update: { toolkit: "googlecalendar", slug: "GOOGLECALENDAR_PATCH_EVENT", useCase: "update event in google calendar", actionClass: "write", forceAsk: false },
  calendar_delete: { toolkit: "googlecalendar", slug: "GOOGLECALENDAR_DELETE_EVENT", useCase: "delete event in google calendar", actionClass: "write", forceAsk: true },
};

interface GoogleAccountInfo {
  alias: string;
  id: string;
  email: string | null;
  name: string | null;
  status: string;
  is_default: boolean;
}

const composioSessionCache = new Map<string, { sessionId: string | undefined; accounts: GoogleAccountInfo[] }>();

function cacheComposioSession(key: string, val: { sessionId: string | undefined; accounts: GoogleAccountInfo[] }) {
  if (composioSessionCache.size >= 50) {
    const oldest = composioSessionCache.keys().next().value;
    if (oldest) composioSessionCache.delete(oldest);
  }
  composioSessionCache.set(key, val);
}

function summarizeAccounts(rawAccounts: any[]): GoogleAccountInfo[] {
  return (Array.isArray(rawAccounts) ? rawAccounts : []).map((a: any) => ({
    alias: String(a.alias ?? ""),
    id: String(a.id ?? ""),
    email: a.user_info?.email ?? a.user_info?.summary ?? null,
    name: a.user_info?.name ?? null,
    status: String(a.status ?? "unknown"),
    is_default: !!a.is_default,
  }));
}

export function resolveGoogleAccount(requested: string | undefined, accounts: GoogleAccountInfo[], toolkit: string): { account?: GoogleAccountInfo; error?: string } {
  const active = accounts.filter((a) => !a.status || a.status.toUpperCase() === "ACTIVE");
  const pool = active.length ? active : accounts;
  if (!pool.length) return { error: `No connected ${toolkit} accounts found in Composio.` };
  const q = requested?.trim();
  if (q) {
    const low = q.toLowerCase();
    const match =
      pool.find((a) => a.alias.toLowerCase() === low || a.id.toLowerCase() === low || (a.email && a.email.toLowerCase() === low)) ??
      pool.find((a) => a.email && a.email.toLowerCase().split("@")[0] === low) ??
      (low === "personal" ? pool.find((a) => a.email?.toLowerCase().endsWith("@gmail.com")) : undefined) ??
      (low === "harwell"
        ? pool.find((a) => a.email?.toLowerCase().endsWith("@school.example.com") && a.email.toLowerCase().includes("owner")) ??
          pool.find((a) => a.email?.toLowerCase().endsWith("@school.example.com"))
        : undefined) ??
      (low === "inception"
        ? pool.find((a) => a.email?.toLowerCase().endsWith("@property.example.com") && a.email.toLowerCase().includes("owner")) ??
          pool.find((a) => a.email?.toLowerCase().endsWith("@property.example.com"))
        : undefined);
    if (!match) {
      return {
        error: `Unknown Google account "${q}" for ${toolkit}. Available accounts: ${pool.map((x) => `${x.alias}${x.email ? ` (${x.email})` : ""}`).join(", ")}`,
      };
    }
    return { account: match };
  }
  const fallback =
    pool.find((a) => a.alias.toLowerCase() === "inception") ??
    pool.find((a) => a.email?.toLowerCase().endsWith("@property.example.com") && a.email.toLowerCase().includes("owner")) ??
    pool.find((a) => a.is_default) ??
    pool[0]!;
  return { account: fallback };
}

function normalizeRecurrence(val: unknown): string[] | undefined {
  const items = Array.isArray(val) ? val : typeof val === "string" ? [val] : [];
  const out = items
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .map((s) => (/^(RRULE|RDATE|EXDATE):/i.test(s) ? s : `RRULE:${s}`));
  return out.length ? out : undefined;
}

const GOOGLE_ALIAS_KEYS = new Set([
  "action",
  "account",
  "extra_json",
  "args",
  "calendarId",
  "timeMin",
  "timeMax",
  "timeZone",
  "maxResults",
  "singleEvents",
  "orderBy",
  "pageToken",
  "limit",
  "text",
  "to",
  "title",
  "start",
  "end",
  "start_datetime",
  "end_datetime",
  "start_time",
  "end_time",
  "details",
  "id",
  "recurrence_rule",
  "rrule",
]);

function withGoogleExtra(raw: Record<string, unknown>, base: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || GOOGLE_ALIAS_KEYS.has(k) || Object.hasOwn(base, k)) continue;
    extra[k] = v;
  }
  return { ...extra, ...base };
}

export function normalizeGoogleArgs(action: string, raw: Record<string, unknown>, tz: string): { args?: Record<string, unknown>; error?: string } {
  const a = raw ?? {};
  const wrap = (base: Record<string, unknown>) => ({ args: withGoogleExtra(a, stripUndefined(base)) });
  switch (action) {
    case "gmail_search":
      return wrap({
        query: a.query,
        max_results: a.max_results ?? a.limit ?? 10,
        label_ids: a.label_ids,
        include_payload: a.include_payload,
        ids_only: a.ids_only,
        page_token: a.page_token,
        include_spam_trash: a.include_spam_trash,
        verbose: a.verbose,
      });
    case "gmail_read": {
      const message_id = a.message_id ?? a.id;
      if (!message_id) return { error: "args.message_id is required for gmail_read" };
      return wrap({ message_id: String(message_id), format: a.format });
    }
    case "gmail_labels":
      return wrap({ include_details: a.include_details });
    case "gmail_draft":
      return wrap({
        recipient_email: a.recipient_email ?? a.to,
        subject: a.subject,
        body: a.body ?? a.text,
        cc: a.cc,
        bcc: a.bcc,
        thread_id: a.thread_id,
        is_html: a.is_html,
        extra_recipients: a.extra_recipients,
        include_signature: a.include_signature,
      });
    case "gmail_send": {
      const recipient_email = a.recipient_email ?? a.to;
      const subject = a.subject;
      const body = a.body ?? a.text;
      if (!recipient_email || !subject || !body) {
        return { error: "args.to (or recipient_email), args.subject, and args.body are required for gmail_send" };
      }
      return wrap({
        recipient_email: String(recipient_email),
        subject: String(subject),
        body: String(body),
        cc: a.cc,
        bcc: a.bcc,
        is_html: a.is_html,
        from_email: a.from_email,
        extra_recipients: a.extra_recipients,
        include_signature: a.include_signature,
      });
    }
    case "gmail_reply": {
      const thread_id = a.thread_id;
      const message_body = a.message_body ?? a.body ?? a.text;
      if (!thread_id || !message_body) return { error: "args.thread_id and args.body (or message_body) are required for gmail_reply" };
      return wrap({
        thread_id: String(thread_id),
        message_body: String(message_body),
        recipient_email: a.recipient_email ?? a.to,
        cc: a.cc,
        bcc: a.bcc,
        is_html: a.is_html,
        extra_recipients: a.extra_recipients,
        include_signature: a.include_signature,
      });
    }
    case "calendar_list":
      return wrap({
        calendarId: a.calendarId ?? a.calendar_id ?? "primary",
        timeMin: a.timeMin ?? a.time_min,
        timeMax: a.timeMax ?? a.time_max,
        timeZone: a.timeZone ?? a.time_zone ?? a.timezone,
        query: a.query,
        maxResults: a.maxResults ?? a.max_results ?? 20,
        singleEvents: a.singleEvents ?? a.single_events ?? true,
        orderBy: a.orderBy ?? a.order_by,
        pageToken: a.pageToken ?? a.page_token,
      });
    case "calendar_get": {
      const event_id = a.event_id ?? a.id;
      if (!event_id) return { error: "args.event_id is required for calendar_get" };
      return wrap({
        calendar_id: a.calendar_id ?? a.calendarId ?? "primary",
        event_id: String(event_id),
        time_zone: a.time_zone ?? a.timezone,
      });
    }
    case "calendar_calendars":
      return wrap({
        max_results: a.max_results,
        page_token: a.page_token,
        show_hidden: a.show_hidden,
        min_access_role: a.min_access_role,
      });
    case "calendar_free_slots":
      return wrap({
        items: a.items,
        time_min: a.time_min ?? a.timeMin,
        time_max: a.time_max ?? a.timeMax,
        timezone: a.timezone ?? tz,
      });
    case "calendar_create":
      return wrap({
        calendar_id: a.calendar_id ?? a.calendarId ?? "primary",
        summary: a.summary ?? a.title,
        start_datetime: a.start_datetime ?? a.start,
        end_datetime: a.end_datetime ?? a.end,
        start_date: a.start_date,
        end_date: a.end_date,
        timezone: a.timezone ?? tz,
        description: a.description ?? a.details,
        location: a.location,
        attendees: a.attendees,
        recurrence: normalizeRecurrence(a.recurrence ?? a.recurrence_rule ?? a.rrule),
        reminders: a.reminders,
        visibility: a.visibility,
        transparency: a.transparency,
        color_id: a.color_id,
        send_updates: a.send_updates,
        create_meeting_room: a.create_meeting_room,
        event_duration_hour: a.event_duration_hour,
        event_duration_minutes: a.event_duration_minutes,
      });
    case "calendar_update": {
      const event_id = a.event_id ?? a.id;
      if (!event_id) return { error: "args.event_id is required for calendar_update" };
      return wrap({
        calendar_id: a.calendar_id ?? a.calendarId ?? "primary",
        event_id: String(event_id),
        summary: a.summary ?? a.title,
        start_time: a.start_time ?? a.start_datetime ?? a.start,
        end_time: a.end_time ?? a.end_datetime ?? a.end,
        timezone: a.timezone,
        description: a.description ?? a.details,
        location: a.location,
        attendees: a.attendees,
        recurrence: normalizeRecurrence(a.recurrence ?? a.recurrence_rule ?? a.rrule),
        reminders: a.reminders,
        visibility: a.visibility,
        transparency: a.transparency,
        color_id: a.color_id,
        send_updates: a.send_updates,
        status: a.status,
      });
    }
    case "calendar_delete": {
      const event_id = a.event_id ?? a.id;
      if (!event_id) return { error: "args.event_id is required for calendar_delete" };
      return wrap({
        calendar_id: a.calendar_id ?? a.calendarId ?? "primary",
        event_id: String(event_id),
        send_updates: a.send_updates,
      });
    }
    default:
      return { error: `Unknown google action: ${action}` };
  }
}

async function getComposioSession(
  runId: number,
  toolkit: "gmail" | "googlecalendar",
  useCase: string,
  userId: string,
  forceRefresh = false,
): Promise<{ sessionId: string | undefined; accounts: GoogleAccountInfo[] }> {
  const key = `${runId}:${toolkit}`;
  if (!forceRefresh) {
    const cached = composioSessionCache.get(key);
    if (cached) return cached;
  }
  const sr = await callRawMcpTool(
    "composio",
    "COMPOSIO_SEARCH_TOOLS",
    { queries: [{ use_case: useCase }], session: { generate_id: true } },
    userId,
  );
  const parsed: any = sr.parsed;
  const sessionId = parsed?.data?.session?.id as string | undefined;
  const statuses: any[] = parsed?.data?.toolkit_connection_statuses ?? [];
  let rawAccounts = statuses.find((s) => s.toolkit === toolkit)?.accounts;
  if (!Array.isArray(rawAccounts)) {
    const mc = await callRawMcpTool(
      "composio",
      "COMPOSIO_MANAGE_CONNECTIONS",
      { toolkits: [{ name: toolkit, action: "list" }] },
      userId,
    );
    rawAccounts = (mc.parsed as any)?.data?.results?.[toolkit]?.accounts ?? [];
  }
  const val = { sessionId, accounts: summarizeAccounts(rawAccounts) };
  cacheComposioSession(key, val);
  return val;
}

export const googleGatewayTool: ToolDef = {
  name: "google",
  skill: "Google",
  status: "Using Google",
  description:
    "Access Gmail and Google Calendar across all 7 connected accounts: personal, inception, accounting, leo, harwell, friday, admissions. Use list_accounts to list connected accounts, or run Gmail and Calendar actions for a specific account alias (defaults to inception). Sending emails, replying, and deleting calendar events always ask approval first.",
  parameters: obj(
    {
      action: {
        type: "string",
        enum: [
          "list_accounts",
          "gmail_search",
          "gmail_read",
          "gmail_draft",
          "gmail_send",
          "gmail_reply",
          "gmail_labels",
          "calendar_list",
          "calendar_get",
          "calendar_calendars",
          "calendar_free_slots",
          "calendar_create",
          "calendar_update",
          "calendar_delete",
        ],
        description: "Google action to perform",
      },
      account: str("Account alias (personal, inception, accounting, leo, harwell, friday, or admissions), email, or account id; defaults to inception"),
      query: str("Gmail search query or calendar event text filter"),
      max_results: num("Maximum number of results to return"),
      message_id: str("Gmail message id for gmail_read"),
      thread_id: str("Gmail thread id for gmail_reply or gmail_draft"),
      to: str("Recipient email address for gmail_send, gmail_draft, or gmail_reply"),
      subject: str("Email subject for gmail_send or gmail_draft"),
      body: str("Email body text for gmail_send, gmail_draft, or gmail_reply"),
      cc: str("Optional CC email address"),
      bcc: str("Optional BCC email address"),
      calendar_id: str("Calendar id (defaults to primary)"),
      event_id: str("Calendar event id for calendar_get, calendar_update, or calendar_delete"),
      summary: str("Event title or summary for calendar_create or calendar_update"),
      start_datetime: str("ISO start datetime for calendar_create or calendar_update"),
      end_datetime: str("ISO end datetime for calendar_create or calendar_update"),
      time_min: str("ISO lower bound timestamp for calendar_list or calendar_free_slots"),
      time_max: str("ISO upper bound timestamp for calendar_list or calendar_free_slots"),
      location: str("Event location for calendar_create or calendar_update"),
      description: str("Event description for calendar_create or calendar_update"),
      attendees: { type: "array", items: { type: "string" }, description: "Attendee email addresses" },
      recurrence: {
        type: "array",
        items: { type: "string" },
        description: "Optional RRULE recurrence list for calendar_create or calendar_update, e.g. [\"RRULE:FREQ=WEEKLY;BYDAY=SA\"]",
      },
      extra_json: str("Optional JSON object string for advanced Gmail or Calendar parameters"),
    },
    ["action"],
  ),
  async run(a, ctx) {
    const action = String(a.action);
    if (action === "list_accounts") {
      const ok = await check({
        userId: ctx.userId,
        runId: ctx.runId,
        chatId: ctx.chatId,
        toolName: "google:list_accounts",
        actionClass: "read",
        target: "composio",
        purpose: "List connected Google accounts",
        connectorMode: "some",
      });
      if (ok === "deny") return { error: "The person denied listing connected Google accounts." };
      markUntrustedRead(ctx.runId);
      const res = await callRawMcpTool(
        "composio",
        "COMPOSIO_MANAGE_CONNECTIONS",
        { toolkits: [{ name: "gmail", action: "list" }, { name: "googlecalendar", action: "list" }] },
        ctx.userId,
      );
      if (res.isError || (res.parsed as any)?.successful === false) {
        return { untrusted_data: true, error: (res.parsed as any)?.error ?? res.text.slice(0, 1500) };
      }
      const results = (res.parsed as any)?.data?.results ?? {};
      const gmail = summarizeAccounts(results.gmail?.accounts ?? []);
      const googlecalendar = summarizeAccounts(results.googlecalendar?.accounts ?? []);
      await ctx.activity("connector", `Listed Google accounts (Gmail: ${gmail.length}, Calendar: ${googlecalendar.length})`, {}, "Google");
      return { untrusted_data: true, gmail, googlecalendar };
    }

    const spec = GOOGLE_ACTIONS[action];
    if (!spec) return { error: `Unknown google action: ${action}` };

    const extraParsed = parseJsonObj(a.extra_json, "extra_json");
    if (extraParsed.error) return { error: extraParsed.error };
    const { action: _act, account: _acc, extra_json: _ej, args: legacyArgs, ...flat } = a as Record<string, unknown>;
    const legacyObj = legacyArgs && typeof legacyArgs === "object" && !Array.isArray(legacyArgs) ? (legacyArgs as Record<string, unknown>) : {};
    const mergedRaw = stripUndefined({ ...extraParsed.value, ...legacyObj, ...flat });

    const norm = normalizeGoogleArgs(action, mergedRaw, ctx.tz);
    if (norm.error || !norm.args) return { error: norm.error ?? "Invalid arguments" };

    let session = await getComposioSession(ctx.runId, spec.toolkit, spec.useCase, ctx.userId);
    const resolved = resolveGoogleAccount(typeof a.account === "string" ? a.account : undefined, session.accounts, spec.toolkit);
    if (resolved.error || !resolved.account) return { error: resolved.error ?? "Could not resolve Google account" };
    const acc = resolved.account;
    const accountLabel = acc.alias || acc.email || acc.id;

    const target =
      spec.actionClass === "send"
        ? String(norm.args.recipient_email ?? norm.args.thread_id ?? accountLabel).toLowerCase()
        : `google:${accountLabel}`;
    const purpose =
      action === "gmail_send"
        ? `Send email via ${accountLabel} (${acc.email ?? acc.id}) to ${norm.args.recipient_email}: "${norm.args.subject}"`
        : action === "gmail_reply"
          ? `Reply to email thread via ${accountLabel} (${acc.email ?? acc.id})`
          : action === "calendar_delete"
            ? `Delete Google Calendar event (${norm.args.event_id}) on ${accountLabel}`
            : `Google ${action} on ${accountLabel}${acc.email ? ` (${acc.email})` : ""}`;

    const ok = await check({
      userId: ctx.userId,
      runId: ctx.runId,
      chatId: ctx.chatId,
      toolName: `google:${action}`,
      actionClass: spec.actionClass,
      target,
      purpose,
      details: { action, account: accountLabel, email: acc.email, args: norm.args },
      forceAsk: spec.forceAsk,
      connectorMode: "some",
    });
    if (ok === "deny") return { error: `The person denied ${action} on ${accountLabel}.` };

    markUntrustedRead(ctx.runId);
    const execArgs = (sid: string | undefined) => ({
      tools: [
        {
          tool_slug: spec.slug,
          arguments: norm.args,
          account: acc.alias || acc.id,
        },
      ],
      sync_response_to_workbench: false,
      ...(sid ? { session_id: sid } : {}),
      thought: `Execute ${spec.slug} for account ${accountLabel}`,
      current_step: action.toUpperCase(),
      current_step_metric: "1/1",
    });

    let res = await callRawMcpTool("composio", "COMPOSIO_MULTI_EXECUTE_TOOL", execArgs(session.sessionId), ctx.userId);
    const firstParsed: any = res.parsed;
    const firstMsg = String(firstParsed?.error ?? firstParsed?.data?.results?.[0]?.response?.error ?? "");
    if ((res.isError || firstParsed?.successful === false) && /session/i.test(firstMsg)) {
      session = await getComposioSession(ctx.runId, spec.toolkit, spec.useCase, ctx.userId, true);
      res = await callRawMcpTool("composio", "COMPOSIO_MULTI_EXECUTE_TOOL", execArgs(session.sessionId), ctx.userId);
    }

    const parsed: any = res.parsed;
    const itemResp = parsed?.data?.results?.[0]?.response;
    if (res.isError || parsed?.successful === false || itemResp?.successful === false) {
      const errMsg = itemResp?.error ?? parsed?.error ?? res.text;
      return {
        untrusted_data: true,
        account_used: { alias: acc.alias, email: acc.email, id: acc.id },
        error: String(errMsg).slice(0, 2000),
      };
    }

    await ctx.activity("connector", `Google ${action} (${accountLabel})`, { action, account: accountLabel, slug: spec.slug }, "Google");
    return {
      untrusted_data: true,
      account_used: { alias: acc.alias, email: acc.email, id: acc.id },
      result: itemResp?.data ?? itemResp?.data_preview ?? parsed?.data ?? parsed,
    };
  },
};

// ---------- 5. windmill gateway (consumes allowlist from connected Windmill MCP server) ----------
const WINDMILL_ACTION_TO_RAW: Record<string, string> = {
  list: "list_workspace_items",
  run_flow: "run_flow",
  run_script: "run_script",
  get_run: "get_run",
};
const WINDMILL_RAW_TO_ACTION: Record<string, string> = {
  list_workspace_items: "list",
  run_flow: "run_flow",
  run_script: "run_script",
  get_run: "get_run",
};

function buildWindmillGateway(wmServer: ConnectedMcpServer): ToolDef {
  const allowedActions: string[] = [];
  const actionToRaw = new Map<string, string>();
  for (const info of wmServer.offeredInfos) {
    const act = WINDMILL_RAW_TO_ACTION[info.name] ?? info.name;
    if (!actionToRaw.has(act)) {
      allowedActions.push(act);
      actionToRaw.set(act, info.name);
    }
  }
  const defaultWs = windmillWorkspace || "admins";
  return {
    name: "windmill",
    skill: "Windmill",
    status: "Using Windmill",
    description:
      `Run and inspect automations in Windmill (allowed actions: ${allowedActions.join(", ")}). ` +
      `Defaults workspace_id to ${defaultWs}. Running flows or scripts requires approval.`,
    parameters: obj(
      {
        action: { type: "string", enum: allowedActions, description: "Windmill action allowed by configuration" },
        path: str("Flow or script workspace path (e.g. f/folder/my_flow) or path_prefix for list"),
        id: str("Job UUID for get_run"),
        query: str("Optional case-insensitive path or summary search filter for list"),
        types: { type: "array", items: { type: "string" }, description: "Item types for list: flow, script, app, folder, resource" },
        args_json: str("Optional JSON object string of input arguments for run_flow or run_script"),
        workspace_id: str(`Target workspace id (defaults to ${defaultWs})`),
        background: { type: "boolean", description: "Run asynchronously and return job id" },
        wait_seconds: num("Seconds to wait for job completion (default 15, max 120)"),
        step: str("Optional step id drill-down for get_run"),
        limit: num("Maximum items to return for list"),
      },
      ["action"],
    ),
    async run(a, ctx) {
      const action = String(a.action);
      const rawName = actionToRaw.get(action);
      const def = rawName ? wmServer.byRawName.get(rawName) : undefined;
      if (!def || !rawName) {
        return { error: `Windmill action "${action}" is not allowed by the current allowlist.` };
      }
      const parsedArgsJson = parseJsonObj(a.args_json ?? a.args, "args_json");
      if (parsedArgsJson.error) return { error: parsedArgsJson.error };
      const extra = parsedArgsJson.value ?? {};
      const ws = String(a.workspace_id || defaultWs);
      const schemaProps = ((def.parameters as any)?.properties ?? {}) as Record<string, unknown>;
      let mcpArgs: Record<string, unknown>;
      if (rawName === "list_workspace_items") {
        mcpArgs = stripUndefined({
          workspace_id: ws,
          types: a.types ?? extra.types,
          query: a.query ?? extra.query,
          path_prefix: a.path ?? extra.path_prefix,
          limit: a.limit ?? extra.limit,
          page: extra.page,
        });
      } else if (rawName === "run_flow" || rawName === "run_script") {
        const path = String(a.path ?? extra.path ?? "").replace(/^\//, "");
        if (!path) return { error: `path is required for ${action}` };
        const runArgs = a.path !== undefined ? (Object.keys(extra).length ? extra : undefined) : extra.args;
        mcpArgs = stripUndefined({
          workspace_id: ws,
          path,
          ...(runArgs !== undefined ? { args: runArgs } : {}),
          background: a.background,
          wait_seconds: a.wait_seconds,
        });
      } else if (rawName === "get_run") {
        const id = a.id ?? extra.id ?? extra.job_id;
        if (!id) return { error: "id (job UUID) is required for get_run" };
        mcpArgs = stripUndefined({
          workspace_id: ws,
          id: String(id),
          step: a.step ?? extra.step,
        });
      } else {
        mcpArgs = stripUndefined({
          ...extra,
          ...(Object.hasOwn(schemaProps, "workspace_id") ? { workspace_id: ws } : {}),
        });
      }
      validateArgs(mcpArgs, def.parameters);
      return def.run(mcpArgs, ctx);
    },
  };
}

// ---------- 6. connectors gateway ----------
const CONNECTOR_ACTIONS: Record<string, string> = {
  list: "connectors_list",
  request: "api_request",
  connect: "connect_app",
  request_credential: "request_credential",
  email_search: "email_search",
  email_send: "email_send",
  calendar_events: "calendar_events",
  calendar_add_event: "calendar_add_event",
};

export const connectorsGatewayTool: ToolDef = {
  name: "connectors",
  skill: "Connectors",
  status: "Using connected apps",
  description:
    "Manage and call Amuse connectors and vault-backed REST APIs: list connected and catalog apps (list), call a custom or REST connector API (request; vault credentials are injected only inside its allowed base URL), show a connect card (connect), ask the owner for a credential securely (request_credential), or use built-in IMAP email and ICS calendar connectors.",
  parameters: obj(
    {
      action: {
        type: "string",
        enum: ["list", "request", "connect", "request_credential", "email_search", "email_send", "calendar_events", "calendar_add_event"],
        description: "Connector operation",
      },
      provider: str("Connector provider id for request or connect"),
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method for request (default GET)" },
      path: str("Relative path or URL for request"),
      body_json: str("Optional JSON object string body for request"),
      headers_json: str("Optional JSON object string of HTTP headers for request"),
      query: str("Words to search for in email_search"),
      days: num("Days to look back for email_search (default 7) or ahead for calendar_events (default 14)"),
      to: str("Recipient email for email_send"),
      subject: str("Subject for email_send"),
      body: str("Plain-text email body for email_send"),
      label: str("Credential label for request_credential, e.g. Todoist API token"),
      host: str("Website or API host for request_credential"),
      instructions: str("Short steps for where to find the credential for request_credential"),
      base_url: str("API base URL for request_credential"),
      header: str("Header template for request_credential"),
      auth: str("Auth style for request_credential, e.g. basic or bearer"),
      title: str("Event title for calendar_add_event"),
      start: str("Local start date-time without offset for calendar_add_event, e.g. 2026-11-18T13:00"),
      end: str("Local end date-time without offset for calendar_add_event"),
      timezone: str("IANA timezone name for calendar_add_event if specified"),
      location: str("Place or video link for calendar_add_event"),
      details: str("Notes or agenda for calendar_add_event"),
      args_json: str("Optional JSON object string of extra parameters for the action"),
    },
    ["action"],
  ),
  async run(a, ctx) {
    const action = String(a.action);
    const underlyingName = CONNECTOR_ACTIONS[action];
    if (!underlyingName) return { error: `Unknown connectors action: ${action}` };
    const target = mustTool(underlyingName);

    const parsedExtra = parseJsonObj(a.args_json ?? a.args, "args_json");
    if (parsedExtra.error) return { error: parsedExtra.error };
    const extra = parsedExtra.value ?? {};

    let mapped: Record<string, unknown>;
    if (action === "list") {
      mapped = {};
    } else if (action === "request") {
      const parsedHeaders = parseJsonObj(a.headers_json ?? a.headers ?? extra.headers, "headers_json");
      if (parsedHeaders.error) return { error: parsedHeaders.error };
      const rawBodyCandidate =
        a.body_json !== undefined
          ? a.body_json
          : typeof a.body === "object" && a.body !== null
            ? a.body
            : typeof a.body === "string" && a.body.trim().startsWith("{")
              ? a.body
              : extra.body;
      const parsedBody = parseJsonObj(rawBodyCandidate, "body_json");
      if (parsedBody.error) return { error: parsedBody.error };
      mapped = stripUndefined({
        provider: a.provider ?? extra.provider,
        method: a.method ?? extra.method ?? "GET",
        path: a.path ?? extra.path,
        body: parsedBody.value,
        headers: parsedHeaders.value,
      });
    } else if (action === "connect") {
      mapped = stripUndefined({ provider: a.provider ?? extra.provider });
    } else {
      const { action: _act, args_json: _aj, body_json: _bj, headers_json: _hj, args: _legacyArgs, ...flat } = a as Record<string, unknown>;
      const merged = stripUndefined({ ...extra, ...flat });
      mapped = pickSchemaKeys(merged, target.parameters);
    }
    validateArgs(mapped, target.parameters);
    return target.run(mapped, ctx);
  },
};

// ---------- 7. workspace gateway (memory, goals, schedules, spaces, ideas, identity, subagents, notify) ----------
const WORKSPACE_BASE_ACTIONS = [
  "memory_save",
  "memory_forget",
  "memory_search",
  "goal_create",
  "goal_update",
  "goals_list",
  "schedule_task",
  "schedule_cancel",
  "schedule_list",
  "space_create",
  "space_update",
  "space_get",
  "ideas_add",
  "set_identity",
  "spawn_subagents",
  "tracking_list",
  "tracking_upsert",
  "tracking_done",
  "doc_list",
  "doc_get",
  "doc_create",
  "doc_update_block",
  "doc_append_blocks",
  "doc_comment_reply",
] as const;

function buildWorkspaceGateway(background: boolean, subagentTool: ToolDef, notifyTool: ToolDef): ToolDef {
  const actions: string[] = [...WORKSPACE_BASE_ACTIONS, ...(background ? ["notify"] : [])];
  const map = byNameMap([...memoryTools, memorySearchTool, ...planningTools, ...spaceTools, ...trackingTools, ...docTools, subagentTool, notifyTool]);
  return {
    name: "workspace",
    skill: "Workspace",
    status: "Updating workspace",
    description:
      "Manage memory (memory_save, memory_forget, memory_search), goals (goal_create, goal_update, goals_list), schedules (schedule_task, schedule_cancel, schedule_list), Spaces (space_create, space_update, space_get), collaborative Docs (doc_list, doc_get, doc_create, doc_update_block, doc_append_blocks, doc_comment_reply), ideas (ideas_add), identity (set_identity), and parallel helpers (spawn_subagents)" +
      (background ? ", or send a proactive message and notification (notify)." : "."),
    parameters: obj(
      {
        action: { type: "string", enum: actions, description: "Workspace action" },
        target: { type: "string", enum: ["user", "memory", "daily"], description: "Memory file target for memory_save" },
        note: str("One concise line to save for memory_save"),
        about: str("Exact full line to remove for memory_forget"),
        query: str("Search phrase for memory_search"),
        title: str("Title for goal_create, schedule_task, space_create, space_update, or notify"),
        description: str("Description for goal_create or space_create"),
        steps: { type: "array", items: { type: "string" }, description: "Ordered plan steps for goal_create" },
        goal_id: num("Goal id for goal_update or schedule_task"),
        complete_step_ids: { type: "array", items: { type: "string" }, description: "Step ids to mark complete in goal_update" },
        add_steps: { type: "array", items: { type: "string" }, description: "New step titles to add in goal_update" },
        status: { type: "string", enum: ["active", "done", "paused", "cancelled"], description: "New status for goal_update or tracking_done" },
        progress_note: str("Short progress note for goal_update"),
        kind: { type: "string", enum: ["reminder", "monitor", "task", "todo", "question", "meeting"], description: "Kind for schedule_task or tracking_upsert" },
        item_id: num("Tracking item id for tracking_upsert or tracking_done"),
        content: str("Concise description for tracking_upsert"),
        due_at: str("Optional ISO 8601 due timestamp for tracking_upsert"),
        due_text: str("Optional vague due text for tracking_upsert"),
        source_ref: str("Optional source ref for tracking_upsert"),
        idempotency_key: str("Optional dedupe key for tracking_upsert"),
        include_closed: { type: "boolean", description: "Include closed items in tracking_list" },
        auto_prep: { type: "boolean", description: "Auto-schedule prep task for meetings in tracking_upsert" },
        prompt: str("Instruction for future run in schedule_task"),
        in_minutes: num("Minutes from now for schedule_task"),
        at_iso: str("ISO datetime for first run in schedule_task"),
        every_minutes: num("Repeat interval in minutes for schedule_task"),
        task_id: num("Scheduled task id for schedule_cancel"),
        space_id: num("Space id for space_update or space_get"),
        doc_id: num("Document id for doc_get, doc_update_block, doc_append_blocks, or doc_comment_reply"),
        block_id: str("Target block id for doc_update_block or doc_comment_reply"),
        after_block_id: str("Optional block id to insert after for doc_append_blocks"),
        block_type: { type: "string", enum: ["p", "h1", "h2", "h3", "bullet", "todo", "callout", "quote", "code", "divider"], description: "Block type for doc_update_block" },
        checked: { type: "boolean", description: "Todo checked state for doc_update_block" },
        resolve: { type: "boolean", description: "Resolve comment thread in doc_comment_reply" },
        markdown: str("Markdown body for doc_create or doc_append_blocks"),
        blocks_json: str("Optional JSON array string of blocks for doc_create or doc_append_blocks"),
        html: str("Full HTML app for space_create or space_update"),
        data_json: str("Optional JSON object string for space_create or space_update data"),
        replace_data: { type: "boolean", description: "Whether to replace rather than merge space data in space_update" },
        refresh_prompt: str("How to refresh space data in background for space_create"),
        refresh_every_minutes: num("Refresh interval in minutes (>= 60) for space_create"),
        emoji: str("Emoji for goal_create, space_create, or set_identity"),
        name: str("Assistant name for set_identity"),
        vibe: str("One-line vibe for set_identity"),
        tasks: { type: "array", items: { type: "string" }, description: "Up to 4 parallel subagent instructions for spawn_subagents" },
        ideas_json: str("JSON array string of idea objects (title, body, prompt, category, emoji) for ideas_add"),
        ...(background ? { message: str("Proactive chat message for notify") } : {}),
        args_json: str("Optional JSON object string of extra parameters for the action"),
      },
      ["action"],
    ),
    async run(a, ctx) {
      const action = String(a.action);
      const target = map.get(action);
      if (!target || !actions.includes(action)) return { error: `Unknown workspace action: ${action}` };
      const parsedExtra = parseJsonObj(a.args_json ?? a.args, "args_json");
      if (parsedExtra.error) return { error: parsedExtra.error };
      const parsedData = parseJsonObj(a.data_json, "data_json");
      if (parsedData.error) return { error: parsedData.error };
      const parsedIdeas = parseJsonArray(a.ideas_json, "ideas_json");
      if (parsedIdeas.error) return { error: parsedIdeas.error };
      const parsedBlocks = parseJsonArray(a.blocks_json, "blocks_json");
      if (parsedBlocks.error) return { error: parsedBlocks.error };

      const { action: _act, args_json: _aj, data_json: _dj, ideas_json: _ij, blocks_json: _bj, args: _legacyArgs, ...flat } = a as Record<string, unknown>;
      const merged = stripUndefined({
        ...parsedExtra.value,
        ...flat,
        ...(parsedData.value !== undefined ? { data: parsedData.value } : {}),
        ...(parsedIdeas.value !== undefined ? { ideas: parsedIdeas.value } : {}),
        ...(parsedBlocks.value !== undefined ? { blocks: parsedBlocks.value } : {}),
      });
      const mapped = pickSchemaKeys(merged, target.parameters);
      validateArgs(mapped, target.parameters);
      return target.run(mapped, ctx);
    },
  };
}

// ---------- 8. create gateway (artifacts, pdf, image, podcast, sandboxed JS & custom tools) ----------
const CREATE_ACTIONS: Record<string, string> = {
  artifact_create: "create_artifact",
  artifact_update: "update_artifact",
  pdf: "create_pdf",
  image: "generate_image",
  podcast: "create_podcast",
  run_code: "run_code",
  save_tool: "save_tool",
  use_tool: "use_tool",
};

export const createGatewayTool: ToolDef = {
  name: "create",
  skill: "Create",
  status: "Creating",
  description:
    "Create rich outputs or run and save sandboxed JavaScript tools: artifact_create, artifact_update, pdf, image, podcast, run_code, save_tool, or use_tool.",
  parameters: obj(
    {
      action: {
        type: "string",
        enum: ["artifact_create", "artifact_update", "pdf", "image", "podcast", "run_code", "save_tool", "use_tool"],
        description: "Creation or code action",
      },
      kind: { type: "string", enum: ["html", "markdown"], description: "Artifact format for artifact_create" },
      title: str("Title for artifact_create, artifact_update, or pdf"),
      content: str("Full HTML or Markdown for artifact_create or artifact_update"),
      artifact_id: num("Artifact id for artifact_update"),
      markdown: str("Document body in Markdown for pdf"),
      prompt: str("Detailed visual description for image"),
      shape: { type: "string", enum: ["square", "portrait", "landscape"], description: "Aspect ratio for image" },
      topic: str("Episode topic for podcast"),
      notes: str("Research notes or key facts for podcast"),
      minutes: num("Target length 1 to 5 minutes for podcast"),
      code: str("JavaScript function body for run_code or save_tool"),
      name: str("Tool name for save_tool or use_tool"),
      description: str("What the tool does and its input shape for save_tool"),
      input_json: str("Optional JSON object string passed as input to run_code or use_tool"),
      args_json: str("Optional JSON object string of extra parameters for the action"),
    },
    ["action"],
  ),
  async run(a, ctx) {
    const action = String(a.action);
    const underlyingName = CREATE_ACTIONS[action];
    if (!underlyingName) return { error: `Unknown create action: ${action}` };
    const target = mustTool(underlyingName);
    const parsedExtra = parseJsonObj(a.args_json ?? a.args, "args_json");
    if (parsedExtra.error) return { error: parsedExtra.error };
    const parsedInput = parseJsonObj(a.input_json, "input_json");
    if (parsedInput.error) return { error: parsedInput.error };

    const { action: _act, args_json: _aj, input_json: _ij, args: _legacyArgs, ...flat } = a as Record<string, unknown>;
    const merged = stripUndefined({
      ...parsedExtra.value,
      ...flat,
      ...(parsedInput.value !== undefined ? { input: parsedInput.value } : {}),
    });
    const mapped = pickSchemaKeys(merged, target.parameters);
    validateArgs(mapped, target.parameters);
    return target.run(mapped, ctx);
  },
};

// ---------- 9. conditional mcp gateway for extra owner-added MCP servers ----------
function buildExtraMcpGateway(extraServers: ConnectedMcpServer[]): ToolDef {
  const summary = extraServers
    .map((s) =>
      s.offeredInfos.length > 12
        ? `${s.name} (${s.offeredInfos.length} tools: ${s.offeredInfos.slice(0, 12).map((i) => i.name).join(", ")}, ...; call action list for all)`
        : `${s.name} (${s.offeredInfos.map((i) => i.name).join(", ")})`,
    )
    .join("; ");
  return {
    name: "mcp",
    skill: "MCP",
    status: "Using an MCP tool",
    description: `Call tools from additional connected MCP servers: ${summary}. Use action list to inspect tool schemas, or action call with server, tool, and args_json.`,
    parameters: obj(
      {
        action: { type: "string", enum: ["list", "call"], description: "List tools or call a tool" },
        server: str("MCP server name for call"),
        tool: str("Exact tool name on that server for call"),
        args_json: str("Optional JSON object string of tool arguments for call"),
      },
      ["action"],
    ),
    async run(a, ctx) {
      const action = String(a.action);
      if (action === "list") {
        return {
          servers: extraServers.map((s) => ({
            name: s.name,
            tools: s.offeredInfos.map((i) => ({
              name: i.name,
              description: i.description ?? "",
              parameters: i.inputSchema ?? { type: "object", properties: {} },
            })),
          })),
        };
      }
      if (action === "call") {
        const serverName = String(a.server ?? "").trim();
        const toolName = String(a.tool ?? "").trim();
        if (!serverName || !toolName) return { error: "server and tool are required for call" };
        const srv = extraServers.find((s) => s.name.toLowerCase() === serverName.toLowerCase());
        if (!srv) return { error: `Unknown extra MCP server "${serverName}". Available: ${extraServers.map((s) => s.name).join(", ")}` };
        const def = srv.byRawName.get(toolName);
        if (!def) {
          return {
            error: `Tool "${toolName}" is not offered by server "${srv.name}". Available: ${srv.offeredInfos.map((i) => i.name).join(", ")}`,
          };
        }
        const parsedArgs = parseJsonObj(a.args_json ?? a.args, "args_json");
        if (parsedArgs.error) return { error: parsedArgs.error };
        const mapped = parsedArgs.value ?? {};
        validateArgs(mapped, def.parameters);
        return def.run(mapped, ctx);
      }
      return { error: `Unknown mcp action: ${action}` };
    },
  };
}

// ---------- Menu assembly ----------
export function buildPresentedTools(opts: {
  background: boolean;
  mcpState: McpRegistryState;
  subagentTool: ToolDef;
  notifyTool: ToolDef;
  fullMenu?: boolean;
  legacyTools?: ToolDef[];
}): ToolDef[] {
  if (opts.fullMenu) {
    const base = opts.legacyTools ?? [
      ...webTools,
      ...browserTools,
      ...memoryTools,
      memorySearchTool,
      ...planningTools,
      ...makerTools,
      ...spaceTools,
      ...mediaTools,
      ...terminalTools,
      ...windmillTools,
      ...codeTools,
      ...connectorTools,
      opts.subagentTool,
    ];
    return (opts.background ? base.concat([opts.notifyTool]) : base).concat(opts.mcpState.tools);
  }

  const composio = findMcpServer(opts.mcpState, "composio");
  const windmill = findMcpServer(opts.mcpState, "windmill");
  const hasWindmill = !!windmill && windmill.offeredInfos.length > 0;
  const extraServers = Array.from(opts.mcpState.servers.values()).filter(
    (s) => s.name.toLowerCase() !== "composio" && s.name.toLowerCase() !== "windmill" && s.offeredInfos.length > 0,
  );

  const menu: ToolDef[] = [gatewayTerminalTool, filesGatewayTool, webGatewayTool];
  if (composio) menu.push(googleGatewayTool);
  if (hasWindmill) menu.push(buildWindmillGateway(windmill!));
  menu.push(
    connectorsGatewayTool,
    buildWorkspaceGateway(opts.background, opts.subagentTool, opts.notifyTool),
    createGatewayTool,
  );
  if (extraServers.length > 0) menu.push(buildExtraMcpGateway(extraServers));
  return menu;
}

// ---------- Subagent safe gateway subset ----------
const subagentFilesTool: ToolDef = {
  ...filesGatewayTool,
  description: "Read, list, or search workspace files.",
  parameters: obj(
    {
      action: { type: "string", enum: ["read", "list", "search"] },
      path: str("Workspace file path or folder prefix"),
      query: str("Literal search phrase"),
    },
    ["action"],
  ),
  async run(a, ctx) {
    if (!["read", "list", "search"].includes(String(a.action))) return { error: "Action not permitted in subagent." };
    return filesGatewayTool.run(a, ctx);
  },
};

const subagentWebTool: ToolDef = {
  ...webGatewayTool,
  description: "Search the web, fetch a page, or check weather.",
  parameters: obj(
    {
      action: { type: "string", enum: ["search", "fetch", "weather"] },
      query: str("Search query"),
      url: str("Absolute http(s) URL"),
      place: str("City or region name"),
    },
    ["action"],
  ),
  async run(a, ctx) {
    if (!["search", "fetch", "weather"].includes(String(a.action))) return { error: "Action not permitted in subagent." };
    return webGatewayTool.run(a, ctx);
  },
};

const subagentCreateTool: ToolDef = {
  ...createGatewayTool,
  description: "Run sandboxed JavaScript (run_code) or an existing custom tool (use_tool).",
  parameters: obj(
    {
      action: { type: "string", enum: ["run_code", "use_tool"], description: "Code action" },
      code: str("JavaScript function body for run_code"),
      name: str("Custom tool name for use_tool"),
      input_json: str("Optional JSON object string passed as input"),
      args_json: str("Optional JSON object string of parameters"),
    },
    ["action"],
  ),
  async run(a, ctx) {
    if (!["run_code", "use_tool"].includes(String(a.action))) return { error: "Action not permitted in subagent." };
    return createGatewayTool.run(a, ctx);
  },
};

export function buildSubagentTools(fullMenu: boolean, legacyTools?: ToolDef[]): ToolDef[] {
  if (fullMenu) {
    return (legacyTools ?? [...webTools, ...memoryTools, memorySearchTool, ...planningTools, ...spaceTools, ...windmillTools, ...codeTools, ...connectorTools]).filter(
      (t) => t.subagentSafe,
    );
  }
  return [subagentFilesTool, subagentWebTool, subagentCreateTool];
}

export { WINDMILL_ACTION_TO_RAW };
