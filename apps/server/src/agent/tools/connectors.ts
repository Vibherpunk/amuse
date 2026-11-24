import { and, eq } from "drizzle-orm";
import { connectorsTable, credentialsTable, db, messagesTable } from "@amuse/db";
import { publish } from "../bus";
import { check, connectorFetch, hostOf, isPublicHost, isPublicUrl, markUntrustedRead, publicFetch } from "../sentinel";
import {
  authHeaderText,
  credentialDestination,
  credentialPlacementError,
  getSecretById,
  isAuthHeader,
  redactSecrets,
  substituteAuthHeader,
  unapprovedCredentialIds,
} from "../../lib/vault";
import { obj, str, type ToolDef } from "./types";
import { CATALOG } from "../connectors";

async function getConnector(userId: string, provider: string) {
  const [c] = await db
    .select()
    .from(connectorsTable)
    .where(and(eq(connectorsTable.userId, userId), eq(connectorsTable.provider, provider)));
  return c ?? null;
}

async function imapClient(userId: string, c: typeof connectorsTable.$inferSelect) {
  const { ImapFlow } = await import("imapflow");
  const pass = c.credentialId ? await getSecretById(userId, c.credentialId) : null;
  const cfg = c.config as any;
  const client = new ImapFlow({
    host: cfg.imapHost,
    port: Number(cfg.imapPort ?? 993),
    secure: true,
    auth: { user: cfg.username, pass: pass ?? "" },
    logger: false,
  });
  await client.connect();
  return client;
}

export const connectorTools: ToolDef[] = [
  {
    name: "connectors_list",
    skill: "Connectors",
    status: "Checking your connections",
    subagentSafe: true,
    description: "List the person's connected apps (and what's available to connect).",
    parameters: obj({}),
    async run(_a, ctx) {
      const rows = await db.select().from(connectorsTable).where(eq(connectorsTable.userId, ctx.userId));
      return {
        connected: rows.map((r) => ({
          provider: r.provider,
          name: r.displayName,
          access: r.access,
          custom: r.custom,
          base_url: (r.config as any).baseUrl,
          auth_token: r.credentialId ? "(use the surrogate from request_credential; never ask for it)" : undefined,
        })),
        available: CATALOG.map((c) => ({ provider: c.id, name: c.name, what: c.description })),
        how_to_connect: "Call connect_app to show a secure connect card in chat, or create a custom connector with request_credential + custom connector.",
      };
    },
  },
  {
    name: "connect_app",
    skill: "Connectors",
    status: "Setting up a connection",
    description:
      "Show the person a secure card to connect an app from the catalog (they enter details there; you never see secrets). Use when they say 'connect my email/calendar/...'.",
    parameters: obj({ provider: str("Catalog provider id") }, ["provider"]),
    async run({ provider }, ctx) {
      const item = CATALOG.find((c) => c.id === provider);
      if (!item) return { error: "Unknown provider", available: CATALOG.map((c) => c.id) };
      ctx.addParts([{ type: "connect_card", provider: item.id, name: item.name }]);
      return { shown_to_person: true, note: "Wait for them to finish; you'll be told when it's connected." };
    },
  },
  {
    name: "request_credential",
    skill: "Connectors",
    status: "Setting up a connection",
    description:
      "Ask the person for an API key or login through a secure card (never in chat). Use when building a custom connector to an API, or when a site needs a login. Optionally creates a custom connector with base_url so you can call it via api_request.",
    parameters: obj(
      {
        label: str("What it is, e.g. 'Todoist API token'"),
        host: str("Website or API host"),
        instructions: str("Short steps for where to find it"),
        base_url: str("API base URL for a custom connector"),
        header: str("Header template, e.g. 'Authorization: Bearer {token}'"),
        auth: str("Auth style: 'basic' when the service signs in with a username & password (HTTP Basic); omit otherwise"),
      },
      ["label", "instructions"],
    ),
    async run(a, ctx) {
      const host = credentialDestination(a.label, a.host, a.base_url);
      const basic = a.auth === "basic";
      ctx.addParts([
        {
          type: "credential_card",
          label: a.label,
          host,
          instructions: a.instructions,
          baseUrl: a.base_url ?? null,
          header: basic ? "Authorization: Basic {token}" : (a.header ?? null),
          auth: basic ? "basic" : null,
        },
      ]);
      return { shown_to_person: true, note: "Stop here and tell them a secure card is waiting. When they submit it you'll get a surrogate token to use." };
    },
  },
  {
    name: "api_request",
    skill: "Connectors",
    status: "Talking to a connected app",
    description:
      "Call a custom connector's HTTP API. Provide the provider id (custom connectors) and a path, or a full URL. Surrogate tokens (amuse_sur_...) are allowed only in authentication headers, never URLs or bodies; they're swapped at the network boundary for the exact bound host. Non-GET requests ask unless allowed; first credential use always asks.",
    parameters: obj(
      {
        provider: str("Custom connector id"),
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        path: str("Path or full URL"),
        body: { type: "object", additionalProperties: true },
        headers: { type: "object", additionalProperties: { type: "string" } },
      },
      ["method", "path"],
    ),
    async run(a, ctx) {
      const c = a.provider ? await getConnector(ctx.userId, a.provider) : null;
      const base = (c?.config as any)?.baseUrl as string | undefined;
      const url = /^https?:/.test(a.path) ? a.path : (base ?? "").replace(/\/$/, "") + "/" + String(a.path).replace(/^\//, "");
      // A custom connector's traffic is scoped to the base URL the person configured for
      // it in Settings: same origin AND within the base URL's path prefix. The destination
      // was chosen by the owner, not the model — that scoping is what lets custom connectors
      // reach tailnet/LAN services (e.g. Windmill) that the public-egress guard would refuse.
      // The relaxed fetch (no DNS pinning) applies only when the base host is private;
      // a public-host custom connector goes through publicFetch like everything else.
      let scoped = false;
      let relaxed = false;
      if (c?.custom && base) {
        try {
          const u = new URL(url);
          const b = new URL(base);
          const basePath = b.pathname.replace(/\/$/, "");
          scoped = u.origin === b.origin && (basePath === "" || u.pathname === basePath || u.pathname.startsWith(basePath + "/"));
          const bh = b.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
          relaxed = scoped && (bh.endsWith(".ts.net") || !isPublicHost(bh));
        } catch {
          scoped = false;
          relaxed = false;
        }
        if (!scoped) return { error: "Custom connector requests must stay within the connector's base URL." };
      }
      if (!scoped && !isPublicUrl(url)) return { error: "Not a public URL" };
      const host = new URL(url).hostname;
      const write = a.method !== "GET";
      if (write && c && c.access !== "readwrite") return { error: "This connection is read-only. The person can allow actions in Settings → Connectors." };
      const headers: Record<string, string> = { "content-type": "application/json", ...(a.headers ?? {}) };
      const tpl = (c?.config as any)?.header as string | undefined;
      if (tpl && c?.credentialId) {
        const [cred] = await db.select().from(credentialsTable).where(eq(credentialsTable.id, c.credentialId));
        if (cred) {
          const [k, ...v] = tpl.split(":");
          const value = v.join(":").trim();
          // A Basic template carries "username:password". The model-visible form is
          // base64(username:surrogate); at egress substituteAuthHeader decodes it,
          // swaps the surrogate for the real password (host-bound, as always) and
          // re-encodes — the password itself is only ever handled server-side.
          headers[k!.trim()] =
            /^basic\s/i.test(value) && value.includes("{token}")
              ? "Basic " + Buffer.from(`${cred.username ?? ""}:${cred.surrogate}`, "utf8").toString("base64")
              : value.replace("{token}", cred.surrogate);
        }
      }
      const rawBody = a.body ? JSON.stringify(a.body) : undefined;
      const placementError = credentialPlacementError(url, rawBody, headers);
      if (placementError) return { error: placementError };
      const credentialIds = await unapprovedCredentialIds(ctx.userId, Object.values(headers).map(authHeaderText).join("\n"));
      const ok = await check({
        userId: ctx.userId,
        runId: ctx.runId,
        chatId: ctx.chatId,
        toolName: "api_request",
        actionClass: write ? "write" : "read",
        target: c?.provider ?? host,
        purpose: `${a.method} ${host}${new URL(url).pathname}`,
        details: { url, body: a.body ?? null, credentialIds },
        composed: { url, kind: "api" },
        forceAsk: credentialIds.length > 0,
        connectorMode: c?.approvalMode === "always" ? "always" : "some",
      });
      if (ok === "deny") return { error: "The person denied this request." };
      let sensitive = false;
      for (const [name, value] of Object.entries(headers)) {
        if (!isAuthHeader(name)) continue;
        const substituted = await substituteAuthHeader(ctx.userId, value, host);
        headers[name] = substituted.text;
        sensitive ||= substituted.used.length > 0;
      }
      // Private-host custom connectors are exempt from the HTTPS rule: the owner configured
      // the destination (e.g. Windmill over HTTP on the tailnet), and the vault still only
      // swaps the credential in for its own bound host. Every other credential-carrying
      // request — including custom connectors on public hosts — keeps the HTTPS requirement
      // and the pinned publicFetch path.
      if (sensitive && !relaxed && new URL(url).protocol !== "https:") return { error: "Requests carrying credentials must use HTTPS." };
      const res = relaxed
        ? await connectorFetch(url, { method: a.method, headers, body: rawBody, signal: AbortSignal.timeout(20000) })
        : await publicFetch(url, { method: a.method, headers, body: rawBody, signal: AbortSignal.timeout(20000) }, { sensitive });
      markUntrustedRead(ctx.runId);
      const text = await redactSecrets(ctx.userId, (await res.text()).slice(0, 15000));
      await ctx.activity("connector", `${a.method} ${c?.displayName ?? host}${String(a.path).slice(0, 40)} → ${res.status}`, {}, "Connectors");
      return { untrusted_data: true, status: res.status, body: text };
    },
  },
  {
    name: "email_search",
    skill: "Email",
    status: "Checking your email",
    subagentSafe: true,
    description:
      "Search the person's connected email inbox (recent messages). Returns sender, subject, date, snippet, uid. One-time codes and password-reset links are filtered out.",
    parameters: obj({ query: str("Words to search for in subject/body (optional)"), days: { type: "number", description: "Look back N days (default 7)" } }),
    async run({ query, days }, ctx) {
      const c = await getConnector(ctx.userId, "email");
      if (!c) return { error: "Email isn't connected. Offer connect_app with provider 'email'." };
      const ok = await check({
        userId: ctx.userId,
        runId: ctx.runId,
        chatId: ctx.chatId,
        toolName: "email_search",
        actionClass: "read",
        target: "email",
        purpose: `Search your email${query ? ` for "${query}"` : ""}`,
        connectorMode: c.approvalMode as any,
      });
      if (ok === "deny") return { error: "Denied" };
      markUntrustedRead(ctx.runId);
      await ctx.setStatus("Checking your email");
      const client = await imapClient(ctx.userId, c);
      const out: any[] = [];
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          const since = new Date(Date.now() - (days ?? 7) * 86400000);
          const crit: any = query ? { since, or: [{ subject: query }, { body: query }] } : { since };
          const uids = ((await client.search(crit, { uid: true })) || []).slice(-25).reverse();
          if (uids.length) {
            for await (const m of client.fetch(uids, { envelope: true, uid: true, bodyParts: ["TEXT"] }, { uid: true })) {
              const raw = m.bodyParts?.get("TEXT")?.toString("utf8") ?? "";
              const snippet = raw
                .replace(/<[^>]+>/g, " ")
                .replace(/=\r?\n/g, "")
                .replace(/\s+/g, " ")
                .slice(0, 300);
              if (/(verification code|one-time|passcode|reset your password|magic link|sign-in link)/i.test((m.envelope?.subject ?? "") + snippet)) continue;
              out.push({
                uid: m.uid,
                from: m.envelope?.from?.[0]?.address,
                name: m.envelope?.from?.[0]?.name,
                subject: m.envelope?.subject,
                date: m.envelope?.date,
                snippet,
              });
            }
          }
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => {});
      }
      await ctx.activity("connector", `Searched email${query ? ` for "${query}"` : ""} (${out.length} results)`, {}, "Email");
      return { untrusted_data: true, messages: out };
    },
  },
  {
    name: "email_send",
    skill: "Email",
    status: "Writing an email",
    description: "Send an email from the person's connected account. Always asks the person to approve the exact message first.",
    parameters: obj({ to: str("Recipient email"), subject: str("Subject"), body: str("Plain-text body") }, ["to", "subject", "body"]),
    async run({ to, subject, body }, ctx) {
      const c = await getConnector(ctx.userId, "email");
      if (!c) return { error: "Email isn't connected." };
      if (c.access !== "readwrite") return { error: "Email is read-only. The person can allow sending in Settings → Connectors." };
      const ok = await check({
        userId: ctx.userId,
        runId: ctx.runId,
        chatId: ctx.chatId,
        toolName: "email_send",
        actionClass: "send",
        target: String(to).trim().toLowerCase(),
        purpose: `Send an email to ${to}: "${subject}"`,
        details: { to, subject, body },
        connectorMode: c.approvalMode === "always" ? "always" : "some",
      });
      if (ok === "deny") return { error: "The person didn't approve sending this email." };
      const nodemailer = await import("nodemailer");
      const cfg = c.config as any;
      const pass = c.credentialId ? await getSecretById(ctx.userId, c.credentialId) : null;
      const t = nodemailer.createTransport({
        host: cfg.smtpHost,
        port: Number(cfg.smtpPort ?? 465),
        secure: Number(cfg.smtpPort ?? 465) === 465,
        auth: { user: cfg.username, pass: pass ?? "" },
      });
      await t.sendMail({ from: cfg.username, to, subject, text: body });
      await ctx.activity("connector", `Sent an email to ${to}: ${subject}`, {}, "Email");
      return { sent: true };
    },
  },
  {
    name: "calendar_add_event",
    skill: "Calendar",
    status: "Preparing a calendar event",
    description:
      "Put a meeting or event on the person's calendar. Shows one-tap 'Add to Google Calendar', 'Add to Outlook' and 'Download .ics' buttons with everything filled in; they tap one to save it. Works whether or not a calendar is connected. Give times as local wall-clock time with no offset; the app applies the person's timezone.",
    parameters: obj(
      {
        title: str("Event title"),
        start: str("Local start date-time, no offset, e.g. 2026-11-18T13:00"),
        end: str("Local end date-time, no offset (default: 1 hour after start)"),
        timezone: str("Only if the person named a different zone: IANA name like America/New_York"),
        location: str("Place or video link"),
        details: str("Notes or agenda"),
      },
      ["title", "start"],
    ),
    async run(a, ctx) {
      const zone = a.timezone || ctx.tz;
      const start = localToUtc(String(a.start), zone);
      if (!start) return { error: "Invalid start time; use local time like 2026-11-18T13:00" };
      const end = a.end ? localToUtc(String(a.end), zone) : new Date(start.getTime() + 3600000);
      if (!end) return { error: "Invalid end time" };
      if (end <= start) return { error: "End must be after start" };
      ctx.addParts([
        {
          type: "calendar_event",
          title: String(a.title).slice(0, 200),
          start: start.toISOString(),
          end: end.toISOString(),
          location: a.location ? String(a.location).slice(0, 300) : null,
          details: a.details ? String(a.details).slice(0, 2000) : null,
        },
      ]);
      await ctx.activity("connector", `Prepared a calendar event: ${a.title}`, {}, "Calendar");
      return {
        shown_to_person: true,
        note: "Tell them to tap 'Add to Google Calendar' (or Outlook / .ics) to save it. Don't claim it's already on their calendar.",
      };
    },
  },
  {
    name: "calendar_events",
    skill: "Calendar",
    status: "Checking your calendar",
    subagentSafe: true,
    description: "Read upcoming events from the person's connected calendar (iCal feed).",
    parameters: obj({ days: { type: "number", description: "Days ahead (default 14)" } }),
    async run({ days }, ctx) {
      const c = await getConnector(ctx.userId, "calendar");
      if (!c) return { error: "Calendar isn't connected. Offer connect_app with provider 'calendar'." };
      const ok = await check({
        userId: ctx.userId,
        runId: ctx.runId,
        chatId: ctx.chatId,
        toolName: "calendar_events",
        actionClass: "read",
        target: "calendar",
        purpose: "Read your calendar",
        connectorMode: c.approvalMode as any,
      });
      if (ok === "deny") return { error: "Denied" };
      const feed = c.credentialId ? await getSecretById(ctx.userId, c.credentialId) : null;
      markUntrustedRead(ctx.runId);
      if (!feed) return { error: "Missing feed" };
      const feedUrl = feed.replace(/^webcal:/, "https:");
      if (!isPublicUrl(feedUrl)) return { error: "The calendar link must be a public https address." };
      const ical = await (await publicFetch(feedUrl, { signal: AbortSignal.timeout(20000) }, { sensitive: true })).text();
      const events = parseIcs(ical, days ?? 14);
      await ctx.activity("connector", `Read ${events.length} upcoming calendar events`, {}, "Calendar");
      return { untrusted_data: true, events };
    },
  },
];

/** Interpret a wall-clock date-time ("2026-11-18T13:00", any offset ignored) in an IANA zone. */
export function localToUtc(s: string, zone: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", sec = "00"] = m;
  const wall = Date.UTC(+y!, +mo! - 1, +d!, +h, +mi, +sec);
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(new Date(t))
        .map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - t;
  };
  try {
    let t = wall - offsetAt(wall);
    t = wall - offsetAt(t);
    return new Date(t);
  } catch {
    return null;
  }
}

function parseIcsDate(v: string) {
  const m = v.match(/(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const [, y, mo, d, , h = "00", mi = "00", s = "00", z] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${z ? "Z" : ""}`);
}

const ICS_FIELDS = Object.fromEntries(["DTSTART", "DTEND", "SUMMARY", "LOCATION"].map((k) => [k, new RegExp(`\\n${k}[^:\\n]*:([^\\n]*)`)]));

export function parseIcs(ics: string, days: number) {
  const now = Date.now();
  const end = now + days * 86400000;
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const out: { title: string; start: string; end?: string; location?: string }[] = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const get = (k: keyof typeof ICS_FIELDS) => block.match(ICS_FIELDS[k]!)?.[1]?.trim();
    const start = parseIcsDate(get("DTSTART") ?? "");
    if (!start) continue;
    const t = start.getTime();
    if (t < now - 3600000 || t > end) continue;
    out.push({
      title: (get("SUMMARY") ?? "(no title)").replace(/\\,/g, ","),
      start: start.toISOString(),
      end: parseIcsDate(get("DTEND") ?? "")?.toISOString(),
      location: get("LOCATION")?.replace(/\\,/g, ","),
    });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start)).slice(0, 60);
}

/** Posts an event message (used after a connect/credential card is completed). */
export async function postEvent(userId: string, chatId: number, content: string) {
  const [m] = await db.insert(messagesTable).values({ userId, chatId, role: "event", content }).returning();
  publish(userId, { type: "message", chatId, message: m });
  return m;
}
