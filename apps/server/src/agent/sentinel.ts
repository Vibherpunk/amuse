import dns from "node:dns/promises";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { and, eq, isNull, or, gt } from "drizzle-orm";
import {
  allowedSitesTable,
  approvalsTable,
  db,
  grantsTable,
  runsTable,
  settingsTable,
  activityTable,
  messagesTable,
  connectorsTable,
  credentialsTable,
} from "@amuse/db";
import { publish } from "./bus";

/**
 * Sentinel: the only authority that decides whether a tool action may run.
 * Tools propose actions; the sentinel answers allow | deny | ask. "ask" creates
 * an approval card in the client and suspends the run until the person answers.
 */
export type ActionClass = "internal" | "read" | "web" | "write" | "send" | "purchase" | "submit";

export interface ProposedAction {
  userId: string;
  runId: number;
  chatId: number;
  toolName: string;
  actionClass: ActionClass;
  target?: string | null; // connector provider or website host
  purpose: string; // user-visible description
  details?: Record<string, unknown>;
  connectorMode?: "some" | "always";
  forceAsk?: boolean;
  composed?: { url: string; kind: "visit" | "type" | "api" };
}

export type Decision = "allow" | "deny";

const pending = new Map<number, (grant: string) => void>();
// Every prompt includes private memory, so outbound trust does not depend on a private-read marker.
const untrustedRuns = new Set<number>();
const trustedUrls = new Map<number, Set<string>>();
export function markUntrustedRead(runId: number) {
  untrustedRuns.add(runId);
}
export function hasUntrustedRead(runId: number) {
  return untrustedRuns.has(runId);
}
export function recordTrustedUrls(runId: number, urls: string[]) {
  const known = trustedUrls.get(runId) ?? new Set<string>();
  for (const url of urls) {
    try {
      known.add(new URL(url).href);
    } catch {}
  }
  trustedUrls.set(runId, known);
}
const HOST_TOKEN = /^(?:[a-z0-9-]{1,63}\.){1,10}[a-z]{2,63}$/;

/** Hostnames mentioned in text, found token by token so the pattern can't backtrack across the whole message. */
export function hostsIn(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9.-]+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t.length <= 253 && HOST_TOKEN.test(t));
}

export function userNamedHosts(messages: string[]): Set<string> {
  return new Set(messages.flatMap(hostsIn));
}
export function userNamedUrls(messages: string[]): Set<string> {
  const urls = new Set<string>();
  for (const message of messages)
    for (const raw of message.match(/https?:\/\/[^\s<>"`]+/gi) ?? []) {
      try {
        urls.add(new URL(raw.replace(/[),.;!?]+$/, "")).href);
      } catch {}
    }
  return urls;
}
export function destinationIsTrusted(
  url: string,
  kind: "visit" | "type" | "api",
  messages: string[],
  citations: Iterable<string>,
  configuredHosts: string[] = [],
): boolean {
  const u = new URL(url);
  if (userNamedHosts(messages).has(u.hostname.toLowerCase())) return true;
  if (userNamedUrls(messages).has(u.href) || new Set(citations).has(u.href)) return true;
  return kind === "api" && configuredHosts.includes(u.hostname.toLowerCase());
}

async function needsDestinationApproval(a: ProposedAction): Promise<boolean> {
  if (!a.composed) return false;
  const host = new URL(a.composed.url).hostname;
  const sites = await db
    .select()
    .from(allowedSitesTable)
    .where(and(eq(allowedSitesTable.userId, a.userId), eq(allowedSitesTable.host, host)));
  if (sites.length) return false;
  const grants = await db
    .select()
    .from(grantsTable)
    .where(
      and(
        eq(grantsTable.userId, a.userId),
        eq(grantsTable.toolName, "outbound_destination"),
        eq(grantsTable.scope, "task"),
        eq(grantsTable.runId, a.runId),
        eq(grantsTable.target, host),
      ),
    );
  if (grants.some((g) => !g.expiresAt || g.expiresAt > new Date())) return false;
  const messages = await db
    .select({ content: messagesTable.content })
    .from(messagesTable)
    .where(and(eq(messagesTable.chatId, a.chatId), eq(messagesTable.userId, a.userId), eq(messagesTable.role, "user")));
  const configuredHosts: string[] = [];
  if (a.composed.kind === "api") {
    const connectors = await db.select().from(connectorsTable).where(eq(connectorsTable.userId, a.userId));
    const credentials = await db.select().from(credentialsTable).where(eq(credentialsTable.userId, a.userId));
    for (const value of [...connectors.map((c) => c.config.baseUrl), ...credentials.map((c) => c.host)]) {
      if (typeof value !== "string") continue;
      try {
        configuredHosts.push(new URL(value.includes("://") ? value : `https://${value}`).hostname);
      } catch {}
    }
  }
  return !destinationIsTrusted(
    a.composed.url,
    a.composed.kind,
    messages.map((m) => m.content),
    trustedUrls.get(a.runId) ?? [],
    configuredHosts,
  );
}

export function actionKey(a: { toolName: string; actionClass: string; target?: string | null; purpose: string }): string {
  return JSON.stringify([a.toolName, a.actionClass, a.target ?? null, a.purpose]);
}

export const SANDBOX_CSP =
  "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src 'self' data: blob:; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

export function stricterConnectorMode(global?: string, local?: string) {
  return global === "always" || local === "always" ? "always" : "some";
}

/** @deprecated Compatibility helper only; approval decisions no longer use payload size or encoding. */
export function carriesPrivatePayload(url: string, body: unknown, message: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (hostsIn(message).includes(u.hostname.toLowerCase())) return false;
  const payload = u.search + (body == null ? "" : JSON.stringify(body));
  return payload.length > 100 || /(?:%[0-9a-f]{2}){8,}|[A-Za-z0-9+/=_-]{40,}/i.test(payload);
}

const GRANT_OPTIONS: Record<ActionClass, string[]> = {
  internal: [],
  read: ["once", "task", "always", "deny"],
  web: ["once", "task", "site", "deny"],
  submit: ["once", "task", "site", "deny"],
  write: ["once", "task", "always", "deny"],
  send: ["once", "task", "always", "deny"],
  purchase: ["once", "deny"],
};

async function hasGrant(a: ProposedAction): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .select()
    .from(grantsTable)
    .where(
      and(eq(grantsTable.userId, a.userId), eq(grantsTable.actionClass, a.actionClass), or(isNull(grantsTable.expiresAt), gt(grantsTable.expiresAt, now))),
    );
  return rows.some((g) => grantMatches(a, g));
}

export function grantMatches(
  a: ProposedAction,
  g: { scope: string; runId: number | null; target: string | null; toolName: string; actionClass: string },
): boolean {
  if (a.forceAsk || a.actionClass === "purchase" || a.actionClass !== g.actionClass) return false;
  if (g.scope === "task")
    return g.runId === a.runId && (g.target === actionKey(a) || (g.toolName === "outbound_destination" && a.actionClass === "web" && g.target === a.target));
  if (g.scope === "site") return !!a.target && g.target === a.target;
  if (g.scope === "always") return g.toolName === a.toolName && (g.target ?? null) === (a.target ?? null);
  return false;
}

async function needsAsk(a: ProposedAction): Promise<boolean> {
  if (a.forceAsk || a.toolName === "outbound_destination") return true;
  if (a.actionClass === "internal") return false;
  if (a.actionClass === "purchase") return true;
  const [s] = await db.select().from(settingsTable).where(eq(settingsTable.userId, a.userId));
  const webDefault = s?.webDefault ?? "some";
  const connectorDefault = stricterConnectorMode(s?.connectorDefault, a.connectorMode);
  if (connectorDefault === "always" && (a.connectorMode || ["api_request", "email_search", "email_send", "calendar_events"].includes(a.toolName))) return true;
  if (await hasGrant(a)) return false;
  if (a.actionClass === "web") {
    if (webDefault === "some") return false; // reading public pages is routine
    if (a.target) {
      const allowed = await db
        .select()
        .from(allowedSitesTable)
        .where(and(eq(allowedSitesTable.userId, a.userId), eq(allowedSitesTable.host, a.target)));
      if (allowed.length) return false;
    }
    return true;
  }
  if (a.actionClass === "read") return connectorDefault === "always";
  // write / send / submit always need consent unless granted
  return true;
}

export async function check(a: ProposedAction): Promise<Decision> {
  if (await needsDestinationApproval(a)) {
    const host = new URL(a.composed!.url).hostname;
    const decision = await check({
      ...a,
      composed: undefined,
      forceAsk: false,
      toolName: "outbound_destination",
      actionClass: "web",
      target: host,
      purpose: `Trust ${host} for ${a.composed!.kind === "type" ? "text entered into its page" : "an agent-composed request"}?`,
      details: { url: a.composed!.url, text: a.details?.text, body: a.details?.body },
    });
    if (decision === "deny") return "deny";
    if (a.actionClass === "web" && !a.forceAsk) return "allow";
  }
  if (!(await needsAsk(a))) return "allow";
  const options = a.forceAsk ? ["once", "deny"] : GRANT_OPTIONS[a.actionClass];
  const [approval] = await db
    .insert(approvalsTable)
    .values({
      userId: a.userId,
      runId: a.runId,
      chatId: a.chatId,
      toolName: a.toolName,
      actionClass: a.actionClass,
      target: a.target ?? null,
      purpose: a.purpose,
      details: a.details ?? {},
      options,
    })
    .returning();
  await db.update(runsTable).set({ status: "waiting_approval" }).where(eq(runsTable.id, a.runId));
  publish(a.userId, { type: "approval", approval });
  publish(a.userId, { type: "status", status: "Waiting for your approval" });

  const grant = await new Promise<string>((resolve) => {
    pending.set(approval!.id, resolve);
    setTimeout(
      () => {
        if (pending.has(approval!.id)) {
          pending.delete(approval!.id);
          resolve("expired");
        }
      },
      1000 * 60 * 60 * 6,
    );
  });
  await db.update(runsTable).set({ status: "running" }).where(eq(runsTable.id, a.runId));
  if (grant === "expired") {
    await db.update(approvalsTable).set({ status: "expired", resolvedAt: new Date() }).where(eq(approvalsTable.id, approval!.id));
    return "deny";
  }
  return grant === "deny" ? "deny" : "allow";
}

/** Called by the approvals route when the person answers a card. */
export async function resolveApproval(userId: string, approvalId: number, grant: string) {
  const [ap] = await db
    .select()
    .from(approvalsTable)
    .where(and(eq(approvalsTable.id, approvalId), eq(approvalsTable.userId, userId)));
  if (!ap || ap.status !== "pending") return null;
  if (!ap.options.includes(grant)) throw new Error("Invalid choice");
  const status = grant === "deny" ? "denied" : "allowed";
  const [updated] = await db.update(approvalsTable).set({ status, grant, resolvedAt: new Date() }).where(eq(approvalsTable.id, approvalId)).returning();
  if (grant === "task" || grant === "site" || grant === "always") {
    await db.insert(grantsTable).values({
      userId,
      toolName: ap.toolName,
      actionClass: ap.actionClass,
      target: grant === "task" && ap.toolName !== "outbound_destination" ? actionKey(ap) : ap.target,
      scope: grant,
      runId: grant === "task" ? ap.runId : null,
    });
    if (grant === "site" && ap.target) {
      await db.insert(allowedSitesTable).values({ userId, host: ap.target }).onConflictDoNothing();
    }
  }
  await db.insert(activityTable).values({
    userId,
    runId: ap.runId,
    kind: "approval",
    summary: `${status === "allowed" ? "You allowed" : "You denied"}: ${ap.purpose}`,
    details: { grant, toolName: ap.toolName, target: ap.target },
  });
  publish(userId, { type: "approval", approval: updated });
  const fn = pending.get(approvalId);
  if (fn) {
    pending.delete(approvalId);
    fn(grant);
  } else {
    // Run no longer waiting (server restarted). Mark run as stopped.
    if (ap.runId)
      await db
        .update(runsTable)
        .set({ status: "stopped", endedAt: new Date() })
        .where(and(eq(runsTable.id, ap.runId), eq(runsTable.status, "waiting_approval")));
  }
  return updated;
}

/** Deny all pending approvals for a run (used when the run is stopped). */
export async function cancelRunApprovals(runId: number) {
  const rows = await db
    .select()
    .from(approvalsTable)
    .where(and(eq(approvalsTable.runId, runId), eq(approvalsTable.status, "pending")));
  for (const r of rows) {
    await db.update(approvalsTable).set({ status: "expired", resolvedAt: new Date() }).where(eq(approvalsTable.id, r.id));
    const fn = pending.get(r.id);
    if (fn) {
      pending.delete(r.id);
      fn("deny");
    }
  }
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// ---------- outbound network policy ----------
// The agent may only reach public internet addresses: never this machine, the LAN, or cloud metadata.

const blockedV4 = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  blockedV4.addSubnet(a, p, "ipv4");
const blockedV6 = new net.BlockList();
blockedV6.addAddress("::", "ipv6");
blockedV6.addAddress("::1", "ipv6");
for (const [a, p] of [
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["2002::", 16],
  ["100::", 64],
] as const)
  blockedV6.addSubnet(a, p, "ipv6");
// IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) addresses carry an IPv4 address in their last 32 bits.
const embedsV4 = new net.BlockList();
embedsV4.addSubnet("::ffff:0:0", 96, "ipv6");
embedsV4.addSubnet("::", 96, "ipv6");
embedsV4.addSubnet("64:ff9b::", 96, "ipv6");

function lastV4(ip6: string): string {
  const parts = ip6.split(":");
  const tail = parts[parts.length - 1]!;
  if (tail.includes(".")) return tail;
  const hi = parseInt(parts[parts.length - 2] || "0", 16);
  const lo = parseInt(tail || "0", 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

export function isBlockedIp(ip: string): boolean {
  ip = ip.replace(/^\[|\]$/g, "");
  const family = net.isIP(ip);
  if (family === 4) return blockedV4.check(ip, "ipv4");
  if (family === 6) {
    if (embedsV4.check(ip, "ipv6")) return blockedV4.check(lastV4(ip), "ipv4");
    return blockedV6.check(ip, "ipv6");
  }
  return true;
}

/** Hostname check without DNS: literal IPs are checked directly; local-only names are refused. */
export function isPublicHost(hostname: string): boolean {
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (net.isIP(h)) return !isBlockedIp(h);
  if (!h.includes(".")) return false; // single-label names resolve on the LAN
  return !(h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa"));
}

export function isPublicUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ["http:", "https:"].includes(u.protocol) && isPublicHost(u.hostname);
  } catch {
    return false;
  }
}

/** Resolves a hostname and returns its addresses, refusing if any of them is private. */
export async function resolvePublic(hostname: string): Promise<{ address: string; family: number }[]> {
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!isPublicHost(h)) throw new Error(`Blocked: ${h} is not a public address`);
  if (net.isIP(h)) return [{ address: h, family: net.isIP(h) }];
  const addrs = await dns.lookup(h, { all: true });
  if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) throw new Error(`Blocked: ${h} resolves to a private address`);
  return addrs;
}

export async function assertPublicUrl(url: string): Promise<void> {
  if (!isPublicUrl(url)) throw new Error("Not a public address");
  await resolvePublic(new URL(url).hostname);
}

// Every connection is made to the address that was checked, so DNS can't change between check and connect.
const pinnedLookup: net.LookupFunction = (hostname, options, cb) => {
  resolvePublic(hostname).then(
    (addrs) => (options?.all ? cb(null, addrs, 0) : cb(null, addrs[0]!.address, addrs[0]!.family)),
    (err) => cb(Object.assign(err, { code: "EBLOCKED" }), ""),
  );
};
const publicDispatcher = new Agent({ connect: { lookup: pinnedLookup } });

/**
 * fetch() for agent-chosen URLs. Checks and pins every hop, including redirects. With
 * `sensitive` (the request carries a credential), redirects to another host are not followed.
 */
export async function publicFetch(url: string, init: RequestInit = {}, opts: { sensitive?: boolean } = {}): Promise<Response> {
  let current = url;
  let req: RequestInit = init;
  const firstHost = new URL(url).hostname;
  for (let hop = 0; hop < 5; hop++) {
    if (!isPublicUrl(current)) throw new Error("Not a public address");
    const res = await undiciFetch(current, { ...(req as Parameters<typeof undiciFetch>[1]), redirect: "manual", dispatcher: publicDispatcher });
    const loc = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !loc) return res as unknown as Response;
    const next = new URL(loc, current);
    if (opts.sensitive && next.hostname !== firstHost) return res as unknown as Response;
    const method = (req.method ?? "GET").toUpperCase();
    // Per the fetch spec: 303 becomes GET (except HEAD); 301/302 only rewrite POST. 307/308 keep everything.
    if ((res.status === 303 && method !== "HEAD") || ((res.status === 301 || res.status === 302) && method === "POST"))
      req = { ...req, method: "GET", body: undefined };
    current = next.href;
  }
  throw new Error("Too many redirects");
}
