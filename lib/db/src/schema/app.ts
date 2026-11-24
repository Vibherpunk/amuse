import { boolean, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

const ts = (name: string) => timestamp(name, { withTimezone: true });
const userRef = () =>
  varchar("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" });

/** The user's personal agent (one per user). */
export const agentsTable = pgTable("agents", {
  userId: varchar("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 60 }),
  avatarUrl: text("avatar_url"),
  avatarStyle: varchar("avatar_style", { length: 60 }),
  vibe: text("vibe"),
  emoji: varchar("emoji", { length: 16 }),
  hatchedAt: ts("hatched_at"),
  proactivity: varchar("proactivity", { length: 12 }).notNull().default("normal"), // off | low | normal | high
  status: text("status").notNull().default("Idle"),
  statusUpdatedAt: ts("status_updated_at").defaultNow(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** OpenClaw-style workspace files (SOUL.md, IDENTITY.md, USER.md, AGENTS.md, MEMORY.md, memory/YYYY-MM-DD.md, files/...). */
export const workspaceFilesTable = pgTable(
  "workspace_files",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    path: text("path").notNull(),
    content: text("content").notNull().default(""),
    mimeType: varchar("mime_type", { length: 100 }).notNull().default("text/markdown"),
    system: boolean("system").notNull().default(false),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workspace_files_user_path").on(t.userId, t.path)],
);

/** Main chat (one per user) and side chats. */
export const chatsTable = pgTable(
  "chats",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    kind: varchar("kind", { length: 12 }).notNull().default("side"), // main | side | background
    title: text("title").notNull().default("New chat"),
    archived: boolean("archived").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("chats_user").on(t.userId)],
);

/**
 * Messages. role: user | assistant | tool | event.
 * parts: rich content (tool calls/results, artifact refs, approval refs, images, browser sessions).
 */
export const messagesTable = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chatsTable.id, { onDelete: "cascade" }),
    userId: userRef(),
    role: varchar("role", { length: 12 }).notNull(),
    content: text("content").notNull().default(""),
    parts: jsonb("parts").$type<unknown[]>().notNull().default([]),
    runId: integer("run_id"),
    proactive: boolean("proactive").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("messages_chat").on(t.chatId, t.id)],
);

/** An agent run (one task execution). */
export const runsTable = pgTable(
  "runs",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    chatId: integer("chat_id").notNull(),
    trigger: varchar("trigger", { length: 20 }).notNull().default("user"), // user | schedule | space | goal | idea
    status: varchar("status", { length: 20 }).notNull().default("running"), // running | waiting_approval | done | error | stopped
    title: text("title"),
    error: text("error"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    startedAt: ts("started_at").notNull().defaultNow(),
    endedAt: ts("ended_at"),
  },
  (t) => [index("runs_user").on(t.userId, t.id)],
);

/** Audit trail of everything the agent did. */
export const activityTable = pgTable(
  "activity",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    runId: integer("run_id"),
    kind: varchar("kind", { length: 30 }).notNull(), // skill | tool | approval | memory | connector | schedule | browser | system
    skill: varchar("skill", { length: 60 }),
    summary: text("summary").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("activity_user").on(t.userId, t.id)],
);

/** Pending/answered approval requests raised by the sentinel. */
export const approvalsTable = pgTable(
  "approvals",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    runId: integer("run_id"),
    chatId: integer("chat_id"),
    toolName: varchar("tool_name", { length: 60 }).notNull(),
    actionClass: varchar("action_class", { length: 20 }).notNull(), // read | write | egress | purchase | send
    target: text("target"), // connector id or site host
    purpose: text("purpose").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    options: jsonb("options").$type<string[]>().notNull().default([]),
    status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | allowed | denied | expired
    grant: varchar("grant", { length: 20 }), // once | task | site | always | deny
    createdAt: ts("created_at").notNull().defaultNow(),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [index("approvals_user").on(t.userId, t.status)],
);

/** Capability grants issued from approvals. */
export const grantsTable = pgTable(
  "grants",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    toolName: varchar("tool_name", { length: 60 }).notNull(),
    actionClass: varchar("action_class", { length: 20 }).notNull(),
    target: text("target"),
    scope: varchar("scope", { length: 20 }).notNull(), // task | site | always
    runId: integer("run_id"),
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("grants_user").on(t.userId)],
);

export type PlanStep = { id: string; title: string; done: boolean; note?: string };

export const goalsTable = pgTable(
  "goals",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: varchar("status", { length: 20 }).notNull().default("active"), // active | done | paused
    plan: jsonb("plan").$type<PlanStep[]>().notNull().default([]),
    progressNote: text("progress_note"),
    emoji: varchar("emoji", { length: 16 }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("goals_user").on(t.userId)],
);

export const ideasTable = pgTable(
  "ideas",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    prompt: text("prompt").notNull(),
    category: varchar("category", { length: 40 }).notNull().default("general"),
    emoji: varchar("emoji", { length: 16 }),
    source: varchar("source", { length: 20 }).notNull().default("agent"), // onboarding | agent | goal
    status: varchar("status", { length: 20 }).notNull().default("new"), // new | started | dismissed
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("ideas_user").on(t.userId)],
);

/** Scheduled tasks: reminders, monitors, recurring jobs, space refreshes. */
export const scheduledTasksTable = pgTable(
  "scheduled_tasks",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    kind: varchar("kind", { length: 20 }).notNull().default("task"), // reminder | monitor | task | space_refresh
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    intervalMinutes: integer("interval_minutes"), // null = one-off
    nextRunAt: ts("next_run_at").notNull(),
    lastRunAt: ts("last_run_at"),
    lastResult: text("last_result"),
    enabled: boolean("enabled").notNull().default(true),
    goalId: integer("goal_id"),
    spaceId: integer("space_id"),
    trackingItemId: integer("tracking_item_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("sched_due").on(t.enabled, t.nextRunAt)],
);

/** Artifacts: rich outputs (html pages, docs, images, audio, pdf). */
export const artifactsTable = pgTable(
  "artifacts",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    chatId: integer("chat_id"),
    kind: varchar("kind", { length: 20 }).notNull(), // html | markdown | image | audio | pdf
    title: text("title").notNull(),
    content: text("content").notNull().default(""), // html/markdown text, or data url / storage key
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("artifacts_user").on(t.userId, t.id)],
);

/** Spaces: user-designed mini apps living in the sidebar/tabs. */
export const spacesTable = pgTable(
  "spaces",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    title: text("title").notNull(),
    emoji: varchar("emoji", { length: 16 }),
    description: text("description").notNull().default(""),
    html: text("html").notNull().default(""),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    placement: varchar("placement", { length: 12 }).notNull().default("sidebar"), // sidebar | tab | hidden
    schedule: jsonb("schedule").$type<{ days?: number[]; fromHour?: number; toHour?: number } | null>(),
    refreshPrompt: text("refresh_prompt"),
    lastRefreshedAt: ts("last_refreshed_at"),
    position: integer("position").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("spaces_user").on(t.userId)],
);

/** Connected services. */
export const connectorsTable = pgTable(
  "connectors",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    provider: varchar("provider", { length: 60 }).notNull(),
    displayName: text("display_name").notNull(),
    custom: boolean("custom").notNull().default(false),
    access: varchar("access", { length: 12 }).notNull().default("read"), // read | readwrite
    approvalMode: varchar("approval_mode", { length: 12 }).notNull().default("some"), // some | always
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    credentialId: integer("credential_id"),
    status: varchar("status", { length: 20 }).notNull().default("connected"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("connectors_user_provider").on(t.userId, t.provider)],
);

/** Secure credential store. Values are AES-GCM encrypted and never shown to the model. */
export const credentialsTable = pgTable(
  "credentials",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    label: text("label").notNull(),
    kind: varchar("kind", { length: 20 }).notNull().default("api_key"), // api_key | login | oauth
    host: text("host"),
    username: text("username"),
    secretEnc: text("secret_enc").notNull(),
    surrogate: varchar("surrogate", { length: 80 }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("credentials_user").on(t.userId)],
);

/** Per-user settings. */
export const settingsTable = pgTable("settings", {
  userId: varchar("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  connectorDefault: varchar("connector_default", { length: 12 }).notNull().default("some"), // some | always
  webDefault: varchar("web_default", { length: 12 }).notNull().default("some"), // some | always
  notifications: boolean("notifications").notNull().default(true),
  voice: varchar("voice", { length: 30 }).notNull().default("alloy"),
  timezone: varchar("timezone", { length: 60 }).notNull().default("America/Los_Angeles"),
  onboardedAt: ts("onboarded_at"),
});

/** Allowed websites (site grants surfaced in settings). */
export const allowedSitesTable = pgTable(
  "allowed_sites",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    host: text("host").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("allowed_sites_user_host").on(t.userId, t.host)],
);

/** Token usage ledger for caps. */
export const usageTable = pgTable(
  "usage",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    day: varchar("day", { length: 10 }).notNull(), // YYYY-MM-DD
    units: integer("units").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    images: integer("images").notNull().default(0),
    audioSeconds: integer("audio_seconds").notNull().default(0),
  },
  (t) => [uniqueIndex("usage_user_day").on(t.userId, t.day)],
);

/** In-app notifications (proactive messages, approvals, reminders). */
export const notificationsTable = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    link: text("link"),
    read: boolean("read").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("notifications_user").on(t.userId, t.read)],
);

/** Browser sessions run by the browser sub-agent. */
export const browserSessionsTable = pgTable("browser_sessions", {
  id: serial("id").primaryKey(),
  userId: userRef(),
  runId: integer("run_id"),
  status: varchar("status", { length: 20 }).notNull().default("active"), // active | user_control | stopped | done
  url: text("url"),
  title: text("title"),
  screenshot: text("screenshot"), // data url (latest frame)
  log: jsonb("log").$type<{ at: string; action: string; detail?: string }[]>().notNull().default([]),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Owner-managed MCP servers (Settings -> MCP servers). */
export const mcpServersTable = pgTable(
  "mcp_servers",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    name: varchar("name", { length: 60 }).notNull(),
    transport: varchar("transport", { length: 16 }).notNull().default("http"),
    url: text("url").notNull(),
    authType: varchar("auth_type", { length: 16 }).notNull().default("none"), // none | bearer | custom
    authHeader: text("auth_header"),
    credentialId: integer("credential_id"),
    allowlist: jsonb("allowlist").$type<string[] | null>().default(null),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("mcp_servers_user_name").on(t.userId, t.name)],
);

/** Tracked real-world commitments, open questions, and upcoming meetings/trips. */
export const trackingItemsTable = pgTable(
  "tracking_items",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    kind: varchar("kind", { length: 16 }).notNull().default("todo"), // todo | question | meeting
    content: text("content").notNull(),
    dueAt: ts("due_at"),
    dueText: text("due_text"),
    status: varchar("status", { length: 16 }).notNull().default("open"), // open | done | cancelled
    revision: integer("revision").notNull().default(1),
    sourceRef: text("source_ref"),
    idempotencyKey: text("idempotency_key"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("tracking_items_user_status").on(t.userId, t.status), uniqueIndex("tracking_items_user_idem").on(t.userId, t.idempotencyKey)],
);

/** Deduplication log for polled external events (Gmail, Calendar, Chat review, Meetings). */
export const proactiveEventsTable = pgTable(
  "proactive_events",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    source: varchar("source", { length: 24 }).notNull(), // gmail | calendar | chat | meeting | chat_review_cursor
    externalKey: text("external_key").notNull(),
    stateHash: varchar("state_hash", { length: 64 }).notNull(),
    dayKey: varchar("day_key", { length: 10 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("seen"), // seen | judged | notified | suppressed
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("proactive_events_dedupe").on(t.userId, t.source, t.externalKey, t.stateHash, t.dayKey)],
);

/** Proactive messages delivered to the user, read nightly by proactive dreaming. */
export const proactiveDeliveriesTable = pgTable(
  "proactive_deliveries",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    source: varchar("source", { length: 32 }).notNull(),
    messageId: integer("message_id").notNull(),
    trackingItemId: integer("tracking_item_id"),
    summary: text("summary").notNull().default(""),
    dreamedAt: ts("dreamed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("proactive_deliveries_user_day").on(t.userId, t.createdAt)],
);

/** Clues extracted by nightly proactive dreaming (14-day TTL, promoted at seen >= 2). */
export const proactiveCluesTable = pgTable(
  "proactive_clues",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    matter: text("matter").notNull(),
    kind: varchar("kind", { length: 64 }).notNull(),
    timeWindow: varchar("time_window", { length: 64 }),
    leaning: varchar("leaning", { length: 24 }).notNull().default("follow_up_later"), // tell_now | follow_up_later | stay_silent
    seen: integer("seen").notNull().default(1),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("proactive_clues_user").on(t.userId, t.lastSeenAt)],
);

/** Versioned learned rules for rollback and auditability. */
export const proactiveRuleVersionsTable = pgTable(
  "proactive_rule_versions",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    version: integer("version").notNull(),
    rules: jsonb("rules").$type<string[]>().notNull().default([]),
    rationale: text("rationale").notNull().default(""),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("proactive_rule_versions_user").on(t.userId, t.version)],
);

export type DocBlockType = "p" | "h1" | "h2" | "h3" | "bullet" | "todo" | "callout" | "quote" | "code" | "divider";

export interface DocComment {
  id: string;
  author: "user" | "agent";
  text: string;
  selection?: string;
  createdAt: string;
  resolved?: boolean;
}

export interface DocBlock {
  id: string;
  type: DocBlockType;
  text: string;
  checked?: boolean;
  comments?: DocComment[];
}

/** Native Notion-style collaborative documents editable by user & Amuse. */
export const documentsTable = pgTable(
  "documents",
  {
    id: serial("id").primaryKey(),
    userId: userRef(),
    title: text("title").notNull().default("Untitled"),
    emoji: varchar("emoji", { length: 16 }).notNull().default("📝"),
    slug: varchar("slug", { length: 120 }).notNull(),
    blocks: jsonb("blocks").$type<DocBlock[]>().notNull().default([]),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("documents_user_updated").on(t.userId, t.updatedAt)],
);
