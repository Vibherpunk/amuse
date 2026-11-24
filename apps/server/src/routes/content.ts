import net from "node:net";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { artifactsTable, browserSessionsTable, connectorsTable, credentialsTable, db, mcpServersTable, messagesTable, scheduledTasksTable, spacesTable } from "@amuse/db";
import { publish } from "../agent/bus";
import { SANDBOX_CSP } from "../agent/sentinel";
import { API_PRESETS, CATALOG } from "../agent/connectors";
import { activeRunFor, startRun, steer } from "../agent/loop";
import { getMcpState, invalidateMcpCache, refreshMcpConnections } from "../agent/mcp";
import { controlSession } from "../agent/tools/browser";
import { postEvent } from "../agent/tools/connectors";
import { record } from "../agent/usage";
import { getMainChatId } from "../agent/workspace";
import { MODELS, speechSeconds, synthesizeSpeech, transcribeOpenai } from "../lib/ai";
import { confirmCredentialDestination, deleteCredential, isAuthHeader, listCredentials, normalizeHost, storeCredential, updateCredential } from "../lib/vault";
import { idParam, requireAuth, uid } from "./helpers";

const router: IRouter = Router();
router.use(requireAuth);

/** Bridge injected into artifact/space iframes: persistent data via postMessage. */
function bridge(kind: "artifact" | "space", id: number, data: unknown) {
  return `<script>(function(){var d=${JSON.stringify(data ?? {}).replace(/</g, "\\u003c")};window.amuse={kind:"${kind}",id:${id},getData:function(){return JSON.parse(JSON.stringify(d))},setData:function(n){d=n;parent.postMessage({amuse:"setData",kind:"${kind}",id:${id},data:n},"*")},ask:function(t){parent.postMessage({amuse:"ask",text:String(t)},"*")}};})();</script>`;
}

function wrapHtml(html: string, inject: string) {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + inject);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + "<head>" + inject + "</head>");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${inject}</head><body>${html}</body></html>`;
}

// Generated pages always run sandboxed in an opaque origin, even when opened in their own tab:
// no access to Amuse's API, no network, and no form submissions.

/** File types Amuse serves inline. Anything else (HTML, SVG, XML...) is only ever downloaded. */
const INLINE_TYPES: Record<string, string[]> = {
  image: ["image/png", "image/jpeg", "image/gif", "image/webp"],
  audio: ["audio/mpeg", "audio/wav", "audio/webm", "audio/ogg"],
  pdf: ["application/pdf"],
};

// ---------- artifacts ----------
router.get("/artifacts", async (req, res) => {
  const rows = await db
    .select({
      id: artifactsTable.id,
      kind: artifactsTable.kind,
      title: artifactsTable.title,
      chatId: artifactsTable.chatId,
      createdAt: artifactsTable.createdAt,
    })
    .from(artifactsTable)
    .where(eq(artifactsTable.userId, uid(req)))
    .orderBy(desc(artifactsTable.id))
    .limit(100);
  res.json({ artifacts: rows });
});

router.get("/artifacts/:id", async (req, res) => {
  const [a] = await db
    .select()
    .from(artifactsTable)
    .where(and(eq(artifactsTable.id, idParam(req)), eq(artifactsTable.userId, uid(req))));
  if (!a) {
    res.status(404).end();
    return;
  }
  const isBinary = a.content.startsWith("data:");
  res.json({ artifact: { ...a, content: isBinary ? undefined : a.content, hasBinary: isBinary } });
});

/**
 * Generated pages are only ever rendered inside a frame whose parent sets frame-src 'self', so they
 * can't navigate to another site (by script, link or meta refresh) to carry data out. Opening one
 * directly in a tab gets a minimal parent page that frames it.
 */
function servedFramed(req: Request, res: Response, src: string) {
  if (req.get("sec-fetch-dest") !== "document") return false;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'");
  res.send(
    `<!doctype html><meta charset="utf-8"><title>Amuse</title><style>html,body,iframe{margin:0;height:100%;width:100%;border:0;display:block}</style><iframe src="${src}" sandbox="allow-scripts allow-forms"></iframe>`,
  );
  return true;
}

router.get("/artifacts/:id/raw", async (req, res) => {
  const [a] = await db
    .select()
    .from(artifactsTable)
    .where(and(eq(artifactsTable.id, idParam(req)), eq(artifactsTable.userId, uid(req))));
  if (!a) {
    res.status(404).end();
    return;
  }
  if (a.content.startsWith("data:") && INLINE_TYPES[a.kind]) {
    const m = a.content.match(/^data:([^;,]+);base64,(.*)$/s);
    const type = m?.[1]?.toLowerCase() ?? "";
    const inline = INLINE_TYPES[a.kind]!.includes(type);
    res.setHeader("Content-Type", inline ? type : "application/octet-stream");
    // Images and audio can't run code, but sandbox them anyway; Chrome won't render PDFs in a sandboxed document.
    if (a.kind !== "pdf") res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'");
    if (req.query.download || !inline)
      res.setHeader("Content-Disposition", `attachment; filename="${a.title.replace(/[^a-z0-9 _-]/gi, "").slice(0, 60) || "file"}"`);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(Buffer.from(m?.[2] ?? "", "base64"));
    return;
  }
  if (a.kind === "html") {
    if (servedFramed(req, res, `/api/artifacts/${a.id}/raw`)) return;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Security-Policy", SANDBOX_CSP);
    res.send(wrapHtml(a.content, bridge("artifact", a.id, (a.meta as any)?.data ?? {})));
    return;
  }
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  res.send(a.content);
});

router.put("/artifacts/:id/data", async (req, res) => {
  const [a] = await db
    .select()
    .from(artifactsTable)
    .where(and(eq(artifactsTable.id, idParam(req)), eq(artifactsTable.userId, uid(req))));
  if (!a) {
    res.status(404).end();
    return;
  }
  await db
    .update(artifactsTable)
    .set({ meta: { ...(a.meta as any), data: req.body?.data ?? {} } })
    .where(eq(artifactsTable.id, a.id));
  res.json({ ok: true });
});

router.delete("/artifacts/:id", async (req, res) => {
  await db.delete(artifactsTable).where(and(eq(artifactsTable.id, idParam(req)), eq(artifactsTable.userId, uid(req))));
  res.json({ ok: true });
});

// ---------- spaces ----------
router.get("/spaces", async (req, res) => {
  const rows = await db
    .select({
      id: spacesTable.id,
      title: spacesTable.title,
      emoji: spacesTable.emoji,
      description: spacesTable.description,
      placement: spacesTable.placement,
      schedule: spacesTable.schedule,
      position: spacesTable.position,
      lastRefreshedAt: spacesTable.lastRefreshedAt,
      updatedAt: spacesTable.updatedAt,
    })
    .from(spacesTable)
    .where(eq(spacesTable.userId, uid(req)))
    .orderBy(spacesTable.position, spacesTable.id);
  res.json({ spaces: rows });
});

router.post("/spaces", async (req, res) => {
  const userId = uid(req);
  const idea = String(req.body?.idea ?? "").trim();
  if (!idea) {
    res.status(400).end();
    return;
  }
  const chatId = await getMainChatId(userId);
  const text = `Build me a space: ${idea}`;
  await db.insert(messagesTable).values({ userId, chatId, role: "user", content: text });
  if (activeRunFor(chatId)) steer(chatId, text);
  else await startRun({ userId, chatId, trigger: "user" });
  res.json({ ok: true, chatId });
});

router.get("/spaces/:id", async (req, res) => {
  const [s] = await db
    .select()
    .from(spacesTable)
    .where(and(eq(spacesTable.id, idParam(req)), eq(spacesTable.userId, uid(req))));
  if (!s) {
    res.status(404).end();
    return;
  }
  const [refresh] = await db
    .select()
    .from(scheduledTasksTable)
    .where(and(eq(scheduledTasksTable.spaceId, s.id), eq(scheduledTasksTable.enabled, true)));
  res.json({ space: { ...s, html: undefined }, refresh: refresh ?? null });
});

router.get("/spaces/:id/raw", async (req, res) => {
  const [s] = await db
    .select()
    .from(spacesTable)
    .where(and(eq(spacesTable.id, idParam(req)), eq(spacesTable.userId, uid(req))));
  if (!s) {
    res.status(404).end();
    return;
  }
  if (servedFramed(req, res, `/api/spaces/${s.id}/raw`)) return;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", SANDBOX_CSP);
  res.send(wrapHtml(s.html, bridge("space", s.id, s.data)));
});

router.put("/spaces/:id/data", async (req, res) => {
  await db
    .update(spacesTable)
    .set({ data: req.body?.data ?? {}, updatedAt: new Date() })
    .where(and(eq(spacesTable.id, idParam(req)), eq(spacesTable.userId, uid(req))));
  res.json({ ok: true });
});

router.patch("/spaces/:id", async (req, res) => {
  const patch: Record<string, unknown> = {};
  for (const k of ["title", "emoji", "placement", "schedule", "position"]) if (Object.hasOwn(req.body ?? {}, k)) patch[k] = req.body[k];
  if (patch.placement && !["sidebar", "tab", "hidden"].includes(String(patch.placement))) {
    res.status(400).end();
    return;
  }
  await db
    .update(spacesTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(spacesTable.id, idParam(req)), eq(spacesTable.userId, uid(req))));
  publish(uid(req), { type: "refresh", what: "spaces" });
  res.json({ ok: true });
});

router.post("/spaces/:id/edit", async (req, res) => {
  const userId = uid(req);
  const [s] = await db
    .select()
    .from(spacesTable)
    .where(and(eq(spacesTable.id, idParam(req)), eq(spacesTable.userId, userId)));
  if (!s) {
    res.status(404).end();
    return;
  }
  const chatId = await getMainChatId(userId);
  const text = `Change my "${s.title}" space (space_id ${s.id}): ${String(req.body?.request ?? "").slice(0, 2000)}`;
  await db.insert(messagesTable).values({ userId, chatId, role: "user", content: text });
  if (activeRunFor(chatId)) steer(chatId, text);
  else await startRun({ userId, chatId, trigger: "user" });
  res.json({ ok: true });
});

router.delete("/spaces/:id", async (req, res) => {
  const userId = uid(req);
  await db
    .update(scheduledTasksTable)
    .set({ enabled: false })
    .where(and(eq(scheduledTasksTable.spaceId, idParam(req)), eq(scheduledTasksTable.userId, userId)));
  await db.delete(spacesTable).where(and(eq(spacesTable.id, idParam(req)), eq(spacesTable.userId, userId)));
  publish(userId, { type: "refresh", what: "spaces" });
  res.json({ ok: true });
});

// ---------- connectors ----------
router.get("/connectors", async (req, res) => {
  const rows = await db
    .select()
    .from(connectorsTable)
    .where(eq(connectorsTable.userId, uid(req)));
  // Usernames and labels live on the credential record (never secrets or surrogates).
  const credMap = new Map((await listCredentials(uid(req))).map((c) => [c.id, c]));
  res.json({
    catalog: CATALOG,
    connected: rows.map((r) => ({
      ...r,
      config: { ...(r.config as any), password: undefined },
      credentialUsername: r.credentialId ? (credMap.get(r.credentialId)?.username ?? null) : null,
      credentialLabel: r.credentialId ? (credMap.get(r.credentialId)?.label ?? null) : null,
    })),
  });
});

// ---------- custom connectors (owner-defined) ----------

/** Private/loopback/link-local/CGNAT IPv4 ranges — the IPv4 half of the private-host rule. */
function isPrivateIPv4(a: number, b: number): boolean {
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** Expand an IPv6 literal to its 8 groups, or null if it doesn't parse. Embedded IPv4 tails become two groups. */
function ipv6Groups(h: string): number[] | null {
  let s = h.split("%")[0]!; // drop any zone id
  const lastColon = s.lastIndexOf(":");
  const tail = lastColon >= 0 ? s.slice(lastColon + 1) : "";
  if (tail.includes(".")) {
    const p = tail.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = s.slice(0, lastColon + 1) + ((p[0]! << 8) | p[1]!).toString(16) + ":" + ((p[2]! << 8) | p[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const out = side.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
    return out.some((n) => Number.isNaN(n)) ? null : out;
  };
  const left = parseSide(halves[0]!);
  const right = halves.length === 2 ? parseSide(halves[1]!) : [];
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

/**
 * Is an IPv6 literal on the person's own networks? Only loopback (::1), link-local
 * (fe80::/10) and unique-local (fc00::/7) count. IPv4-mapped (::ffff:a.b.c.d) and
 * IPv4-compatible forms are judged by their embedded IPv4 address, so a mapped
 * public address can never sneak through as "private".
 */
function isPrivateIPv6(h: string): boolean {
  const g = ipv6Groups(h);
  if (!g) return false;
  const head5Zero = g.slice(0, 5).every((n) => n === 0);
  if (head5Zero && g[5] === 0xffff) return isPrivateIPv4(g[6]! >> 8, g[6]! & 0xff); // IPv4-mapped
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true; // ::1 loopback
  if (g.every((n) => n === 0)) return true; // :: unspecified — this machine only
  if (g.slice(0, 6).every((n) => n === 0)) return isPrivateIPv4(g[6]! >> 8, g[6]! & 0xff); // IPv4-compatible
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  return false;
}

/** Hosts that only exist on the person's own networks: local names, private/loopback/link-local/CGNAT IPs, tailnet names. */
function isPrivateHost(hostname: string): boolean {
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (h.includes(":") || net.isIP(h) === 6) return isPrivateIPv6(h); // IPv6 literals are parsed explicitly, never via the single-label branch
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa") || h.endsWith(".ts.net")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) return isPrivateIPv4(Number(m[1]), Number(m[2]));
  if (net.isIP(h)) return false; // an IP literal that matched nothing above is public
  if (!h.includes(".")) return true; // single-label LAN name
  return false;
}

/**
 * The vault binds a credential to its host through normalizeHost, which can only
 * represent dotted hostnames (host.docker.internal, a *.ts.net name, a dotted IPv4).
 * A credentialed connector on any other host shape (localhost, a single-label name,
 * an IP literal) could never authenticate, so reject it up front with the remedy.
 */
function assertCredentialHostRepresentable(host: string): void {
  if (!normalizeHost(host))
    throw new Error(
      `A saved credential needs a dotted address (like host.docker.internal or a *.ts.net name); "${host}" can't be used with one. Use a dotted address, or choose 'No authentication'.`,
    );
}

/** Validate a custom connector base URL. HTTPS anywhere; HTTP only to the person's own networks. */
function parseConnectorBaseUrl(raw: unknown): { baseUrl: string; host: string } {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("Base URL isn't a valid URL.");
  }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Base URL must start with http:// or https://");
  if (u.username || u.password) throw new Error("Base URL must not contain a username or password.");
  if (u.protocol === "http:" && !isPrivateHost(u.hostname))
    throw new Error("HTTP base URLs are only allowed for local, LAN or tailnet addresses. Use HTTPS for public services.");
  u.hash = "";
  u.search = "";
  return { baseUrl: u.href.replace(/\/$/, ""), host: u.hostname };
}

/** Resolve the auth style chosen in Settings to the stored header template (null = no auth). */
function resolveAuthHeader(auth: unknown, template: unknown): string | null {
  const style = String(auth ?? "bearer");
  if (style === "none") return null;
  if (style === "bearer") return "Authorization: Bearer {token}";
  if (style === "basic") return "Authorization: Basic {token}";
  if (style === "custom") {
    const tpl = String(template ?? "").trim();
    if (/[\x00-\x1f\x7f]/.test(tpl)) throw new Error("Header template must not contain control characters.");
    const idx = tpl.indexOf(":");
    if (idx < 1) throw new Error("Header template must look like 'Authorization: Bearer {token}'.");
    const name = tpl.slice(0, idx).trim();
    if (!isAuthHeader(name)) throw new Error(`"${name}" isn't an authentication header. Use Authorization or an API-key header (e.g. X-Api-Key).`);
    if (!tpl.includes("{token}")) throw new Error("Header template must contain {token} where the credential goes.");
    return tpl;
  }
  throw new Error("Unknown auth style.");
}

/** A header template that carries the credential as an HTTP Basic username:password pair. */
function isBasicHeaderTemplate(tpl: unknown): boolean {
  if (typeof tpl !== "string") return false;
  const idx = tpl.indexOf(":");
  if (idx < 1) return false;
  return /^basic\s/i.test(tpl.slice(idx + 1).trim()) && tpl.includes("{token}");
}

/** Usernames aren't secret, but they must be usable inside a Basic header: no colon, no control characters. */
function parseUsername(raw: unknown): string {
  const u = String(raw ?? "").trim();
  if (/[\x00-\x1f\x7f]/.test(u) || u.includes(":")) throw new Error("Username must not contain a colon or control characters.");
  if (u.length > 200) throw new Error("Username is too long.");
  return u;
}

async function maybeDeleteConnectorCredential(userId: string, conn: typeof connectorsTable.$inferSelect) {
  if (!conn.credentialId) return;
  if ((conn.config as any)?.credentialSource === "vault") return;
  const otherConn = await db
    .select({ id: connectorsTable.id })
    .from(connectorsTable)
    .where(and(eq(connectorsTable.userId, userId), eq(connectorsTable.credentialId, conn.credentialId), ne(connectorsTable.provider, conn.provider)));
  if (otherConn.length > 0) return;
  const usedByMcp = await db
    .select({ id: mcpServersTable.id })
    .from(mcpServersTable)
    .where(and(eq(mcpServersTable.userId, userId), eq(mcpServersTable.credentialId, conn.credentialId)));
  if (usedByMcp.length > 0) return;
  await deleteCredential(userId, conn.credentialId);
}

router.post("/connectors/custom", async (req, res) => {
  const userId = uid(req);
  const name = String(req.body?.name ?? "").trim().slice(0, 60);
  if (!name) {
    res.status(400).json({ error: "Name is required" });
    return;
  }
  let base: { baseUrl: string; host: string };
  let header: string | null;
  try {
    base = parseConnectorBaseUrl(req.body?.baseUrl);
    header = resolveAuthHeader(req.body?.auth, req.body?.header);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }
  const credIdRaw = req.body?.credentialId;
  const hasVaultCred = credIdRaw !== undefined && credIdRaw !== null && credIdRaw !== "";
  const token = String(req.body?.token ?? "");
  const basic = isBasicHeaderTemplate(header);
  let username: string | null = null;
  let vaultCred: typeof credentialsTable.$inferSelect | null = null;

  if (header && hasVaultCred) {
    const vaultCredId = Number(credIdRaw);
    if (!Number.isInteger(vaultCredId) || vaultCredId <= 0) {
      res.status(400).json({ error: "Invalid vault login selected." });
      return;
    }
    const [found] = await db
      .select()
      .from(credentialsTable)
      .where(and(eq(credentialsTable.userId, userId), eq(credentialsTable.id, vaultCredId)));
    if (!found) {
      res.status(400).json({ error: "Selected vault login was not found." });
      return;
    }
    if (basic && !found.username) {
      res.status(400).json({ error: "Selected vault login has no username; Basic authentication requires a username." });
      return;
    }
    vaultCred = found;
  } else {
    if (basic) {
      try {
        username = parseUsername(req.body?.username);
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
        return;
      }
      if (!username) {
        res.status(400).json({ error: "Enter the username for this connector, or choose a different authentication style." });
        return;
      }
    }
    if (header && !token) {
      res.status(400).json({
        error: basic
          ? "Select a vault login or enter the password for this connector, or choose 'No authentication'."
          : "Select a vault login or enter the API token for this connector, or choose 'No authentication'.",
      });
      return;
    }
  }
  if (header) {
    try {
      assertCredentialHostRepresentable(base.host);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      return;
    }
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "connector";
  let provider = `custom-${slug}`;
  for (let n = 2; ; n++) {
    const [existing] = await db
      .select()
      .from(connectorsTable)
      .where(and(eq(connectorsTable.userId, userId), eq(connectorsTable.provider, provider)));
    if (!existing) break;
    provider = `custom-${slug}-${n}`;
  }
  const inlineCred =
    !vaultCred && token
      ? await storeCredential(userId, { label: `${name} credential`, kind: basic ? "login" : "api_key", host: base.host, username, secret: token })
      : null;
  const credentialId = vaultCred ? vaultCred.id : (inlineCred?.id ?? null);
  const credentialSource = vaultCred ? "vault" : inlineCred ? "inline" : undefined;
  try {
    const [row] = await db
      .insert(connectorsTable)
      .values({
        userId,
        provider,
        displayName: name,
        custom: true,
        access: req.body?.access === "readwrite" ? "readwrite" : "read",
        config: { baseUrl: base.baseUrl, header, ...(credentialSource ? { credentialSource } : {}) },
        credentialId,
      })
      .returning();
    res.json({ ok: true, connector: row });
  } catch (e) {
    if (inlineCred) await deleteCredential(userId, inlineCred.id); // never leave a newly created inline credential orphaned
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post("/connectors/:provider", async (req, res) => {
  const userId = uid(req);
  const provider = String(req.params.provider);
  const item = CATALOG.find((c) => c.id === provider);
  if (!item) {
    res.status(404).end();
    return;
  }
  const fields = (req.body?.fields ?? {}) as Record<string, string>;
  const secretField = item.fields.find((f) => f.secret);
  const secret = secretField ? String(fields[secretField.key] ?? "") : "";
  if (secretField && !secret) {
    res.status(400).json({ error: `${secretField.label} is required` });
    return;
  }
  const config: Record<string, unknown> = {};
  for (const f of item.fields) if (!f.secret) config[f.key] = fields[f.key];
  if (provider === "email") {
    config.imapHost ||= "imap.gmail.com";
    config.smtpHost ||= "smtp.gmail.com";
    config.imapPort = 993;
    config.smtpPort = 465;
    try {
      const { ImapFlow } = await import("imapflow");
      const c = new ImapFlow({ host: String(config.imapHost), port: 993, secure: true, auth: { user: String(config.username), pass: secret }, logger: false });
      await c.connect();
      await c.logout();
    } catch (e) {
      res.status(400).json({ error: "Couldn't sign in to your email with those details. Check the app password and server." });
      return;
    }
  }
  if (Object.hasOwn(API_PRESETS, provider)) Object.assign(config, API_PRESETS[provider]);
  const cred = secret ? await storeCredential(userId, { label: `${item.name} credential`, kind: "api_key", host: provider, secret }) : null;
  await db
    .insert(connectorsTable)
    .values({
      userId,
      provider,
      displayName: item.name.split(" (")[0]!,
      access: req.body?.access === "readwrite" ? "readwrite" : "read",
      config,
      credentialId: cred?.id ?? null,
    })
    .onConflictDoUpdate({
      target: [connectorsTable.userId, connectorsTable.provider],
      set: { config, credentialId: cred?.id ?? null, status: "connected", access: req.body?.access === "readwrite" ? "readwrite" : "read" },
    });
  const chatId = req.body?.chatId ? Number(req.body.chatId) : await getMainChatId(userId);
  await postEvent(userId, chatId, `${item.name.split(" (")[0]} connected (${req.body?.access === "readwrite" ? "read & act" : "read only"}).`);
  if (req.body?.continue && !activeRunFor(chatId)) await startRun({ userId, chatId, trigger: "event" });
  res.json({ ok: true });
});

router.patch("/connectors/:provider", async (req, res) => {
  const userId = uid(req);
  const provider = String(req.params.provider);
  const patch: Record<string, unknown> = {};
  if (["read", "readwrite"].includes(req.body?.access)) patch.access = req.body.access;
  if (["some", "always"].includes(req.body?.approvalMode)) patch.approvalMode = req.body.approvalMode;
  const wantsConfig = ["name", "baseUrl", "auth", "header", "token", "clearCredential", "username", "credentialId"].some((k) =>
    Object.hasOwn(req.body ?? {}, k),
  );
  if (wantsConfig) {
    const [c] = await db
      .select()
      .from(connectorsTable)
      .where(and(eq(connectorsTable.userId, userId), eq(connectorsTable.provider, provider)));
    if (!c) {
      res.status(404).end();
      return;
    }
    if (!c.custom) {
      res.status(400).json({ error: "Only custom connectors can be edited." });
      return;
    }
    let newCredId: number | null = null;
    let rowUpdated = false;
    try {
      const cfg: Record<string, unknown> = { ...(c.config as any) };
      let host = "";
      if (Object.hasOwn(req.body, "baseUrl")) {
        const parsed = parseConnectorBaseUrl(req.body.baseUrl);
        cfg.baseUrl = parsed.baseUrl;
        host = parsed.host;
      } else if (typeof cfg.baseUrl === "string") {
        try {
          host = new URL(cfg.baseUrl).hostname;
        } catch {
          host = "";
        }
      }
      if (Object.hasOwn(req.body, "auth") || Object.hasOwn(req.body, "header")) {
        if (!Object.hasOwn(req.body, "auth") && req.body.header === null) {
          cfg.header = null;
        } else if (Object.hasOwn(req.body, "auth")) {
          cfg.header = resolveAuthHeader(req.body.auth, req.body.header ?? cfg.header);
        } else {
          // A header-only PATCH supplies a full template: honor it as a custom template
          // instead of silently replacing it with the Bearer default.
          cfg.header = resolveAuthHeader("custom", req.body.header);
        }
      }
      if (Object.hasOwn(req.body, "name")) {
        const name = String(req.body.name ?? "").trim().slice(0, 60);
        if (!name) throw new Error("Name can't be empty.");
        patch.displayName = name;
      }
      const token = typeof req.body.token === "string" ? req.body.token : "";
      const credIdRaw = req.body?.credentialId;
      const hasVaultCred = Object.hasOwn(req.body, "credentialId") && credIdRaw !== null && credIdRaw !== "";
      const clearing = req.body.clearCredential === true || cfg.header === null;
      if (req.body.clearCredential === true) cfg.header = null; // clearing the credential also nulls the header
      const basic = isBasicHeaderTemplate(cfg.header);
      const hasUsername = Object.hasOwn(req.body, "username");
      const newUsername = hasUsername ? parseUsername(req.body.username) : null;
      let existingUsername: string | null = null;
      if (c.credentialId) {
        const creds = await listCredentials(userId);
        existingUsername = creds.find((x) => x.id === c.credentialId)?.username ?? null;
      }
      let vaultCred: typeof credentialsTable.$inferSelect | null = null;
      if (!clearing && hasVaultCred) {
        const vaultCredId = Number(credIdRaw);
        if (!Number.isInteger(vaultCredId) || vaultCredId <= 0) throw new Error("Invalid vault login selected.");
        const [found] = await db
          .select()
          .from(credentialsTable)
          .where(and(eq(credentialsTable.userId, userId), eq(credentialsTable.id, vaultCredId)));
        if (!found) throw new Error("Selected vault login was not found.");
        if (basic && !found.username) throw new Error("Selected vault login has no username; Basic authentication requires a username.");
        vaultCred = found;
      } else {
        if (basic && !clearing && !(hasUsername ? newUsername : existingUsername)) {
          throw new Error("Basic authentication needs a username. Enter the username for this connector.");
        }
      }
      if (cfg.header !== null && cfg.header !== undefined && !token && !vaultCred && !clearing && !c.credentialId) {
        throw new Error("This connector's authentication header needs a credential. Pick a vault login, enter a token, or choose 'No authentication'.");
      }
      if (cfg.header !== null && cfg.header !== undefined && (token || vaultCred || (!clearing && c.credentialId))) {
        assertCredentialHostRepresentable(host);
      }
      if (clearing) {
        delete cfg.credentialSource;
        patch.credentialId = null;
      } else if (vaultCred) {
        cfg.credentialSource = "vault";
        patch.credentialId = vaultCred.id;
      } else if (token) {
        const cred = await storeCredential(userId, {
          label: `${String(patch.displayName ?? c.displayName)} credential`,
          kind: basic ? "login" : "api_key",
          host,
          username: basic ? (hasUsername ? newUsername : existingUsername) : null,
          secret: token,
        });
        newCredId = cred.id;
        cfg.credentialSource = "inline";
        patch.credentialId = cred.id;
      }
      patch.config = cfg;
      await db
        .update(connectorsTable)
        .set(patch)
        .where(and(eq(connectorsTable.userId, userId), eq(connectorsTable.provider, provider)));
      rowUpdated = true;
      if ((clearing || token || vaultCred) && c.credentialId && c.credentialId !== (patch.credentialId ?? null)) {
        await maybeDeleteConnectorCredential(userId, c);
      }
      if (
        basic &&
        !clearing &&
        !token &&
        !vaultCred &&
        hasUsername &&
        c.credentialId &&
        (c.config as any)?.credentialSource !== "vault" &&
        newUsername !== existingUsername
      ) {
        await db
          .update(credentialsTable)
          .set({ username: newUsername })
          .where(and(eq(credentialsTable.id, c.credentialId), eq(credentialsTable.userId, userId)));
      }
    } catch (e) {
      if (newCredId !== null && !rowUpdated) await deleteCredential(userId, newCredId);
      res.status(400).json({ error: (e as Error).message });
      return;
    }
    res.json({ ok: true });
    return;
  }
  await db
    .update(connectorsTable)
    .set(patch)
    .where(and(eq(connectorsTable.userId, userId), eq(connectorsTable.provider, provider)));
  res.json({ ok: true });
});

router.delete("/connectors/:provider", async (req, res) => {
  const userId = uid(req);
  const [c] = await db
    .select()
    .from(connectorsTable)
    .where(and(eq(connectorsTable.userId, userId), eq(connectorsTable.provider, String(req.params.provider))));
  if (c) await maybeDeleteConnectorCredential(userId, c);
  await db.delete(connectorsTable).where(and(eq(connectorsTable.userId, userId), eq(connectorsTable.provider, String(req.params.provider))));
  res.json({ ok: true });
});

// ---------- credentials (secure store) ----------
router.get("/credentials", async (req, res) => {
  res.json({ credentials: (await listCredentials(uid(req))).map(({ surrogate: _s, ...c }) => c) });
});

router.post("/credentials", async (req, res) => {
  const userId = uid(req);
  const { label, host, username, secret, baseUrl, header, chatId: rawChat, auth } = req.body ?? {};
  if (!label || !secret) {
    res.status(400).json({ error: "Label and secret are required" });
    return;
  }
  let destination: string;
  let parsedBase: { baseUrl: string; host: string } | null = null;
  let headerTemplate: string | null = null;
  try {
    if (baseUrl) {
      // Same base-URL validation as the Settings flow: scheme rule, no embedded
      // userinfo, query/fragment stripped rather than stored verbatim.
      parsedBase = parseConnectorBaseUrl(baseUrl);
      assertCredentialHostRepresentable(parsedBase.host);
    }
    destination = confirmCredentialDestination(String(label), host, parsedBase?.baseUrl ?? baseUrl, req.body?.confirmedHost);
    if (header) {
      const tpl = String(header).trim();
      if (/[\x00-\x1f\x7f]/.test(tpl)) throw new Error("Header template must not contain control characters.");
      const idx = tpl.indexOf(":");
      if (idx < 1 || !isAuthHeader(tpl.slice(0, idx).trim())) throw new Error("Credentials must use an authentication header.");
      if (!tpl.includes("{token}")) throw new Error("Header template must contain {token} where the credential goes.");
      headerTemplate = tpl;
    }
    // Basic (username & password): the card collects a username, and the connector's
    // header template carries the pair. A username is mandatory — without one the
    // connector could never authenticate.
    if (auth === "basic" && !headerTemplate) headerTemplate = "Authorization: Basic {token}";
    if (isBasicHeaderTemplate(headerTemplate) && !(username && parseUsername(username)))
      throw new Error("A username is required for Basic authentication.");
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }
  const cred = await storeCredential(userId, { label, host: destination, username, secret, kind: username ? "login" : "api_key" });
  let note = `Credential saved securely: "${label}", bound to ${destination}. Use surrogate token ${cred.surrogate} only in API authentication headers or browser password/credential fields, never URLs or bodies. First use requires approval.`;
  if (parsedBase) {
    // Same uniqueness rule as the Settings create: the card flow must never silently
    // overwrite a connector that already owns this provider id.
    const slug =
      String(label)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 30) || "connector";
    let provider = `custom-${slug}`;
    for (let n = 2; ; n++) {
      const [existing] = await db
        .select()
        .from(connectorsTable)
        .where(and(eq(connectorsTable.userId, userId), eq(connectorsTable.provider, provider)));
      if (!existing) break;
      provider = `custom-${slug}-${n}`;
    }
    try {
      await db.insert(connectorsTable).values({
        userId,
        provider,
        displayName: label,
        custom: true,
        access: "readwrite",
        config: { baseUrl: parsedBase.baseUrl, header: headerTemplate ?? "Authorization: Bearer {token}" },
        credentialId: cred.id,
      });
    } catch (e) {
      await deleteCredential(userId, cred.id); // never leave a credential orphaned by a failed create
      res.status(500).json({ error: (e as Error).message });
      return;
    }
    note += ` Custom connector "${provider}" created for ${parsedBase.baseUrl}; call it with api_request (auth header added automatically).`;
  }
  const chatId = rawChat ? Number(rawChat) : await getMainChatId(userId);
  await postEvent(userId, chatId, note);
  if (!activeRunFor(chatId)) await startRun({ userId, chatId, trigger: "event" });
  res.json({ ok: true });
});

async function detachAndDeleteCredential(userId: string, id: number) {
  await db
    .update(connectorsTable)
    .set({ credentialId: null })
    .where(and(eq(connectorsTable.userId, userId), eq(connectorsTable.credentialId, id)));
  const detachedMcps = await db
    .update(mcpServersTable)
    .set({ credentialId: null, updatedAt: new Date() })
    .where(and(eq(mcpServersTable.userId, userId), eq(mcpServersTable.credentialId, id)))
    .returning({ id: mcpServersTable.id });
  await deleteCredential(userId, id);
  if (detachedMcps.length > 0) await refreshMcpConnections(userId).catch(() => {});
}

router.delete("/credentials/:id", async (req, res) => {
  await detachAndDeleteCredential(uid(req), idParam(req));
  res.json({ ok: true });
});

// ---------- vault (owner-managed named logins, write-only secrets) ----------
function parseVaultHost(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) throw new Error("Host or base URL is required.");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw new Error("Host / base URL is not a valid URL.");
    }
    if (u.username || u.password) throw new Error("Host / base URL must not embed a username or password.");
  }
  const h = normalizeHost(s);
  if (!h) throw new Error(`Enter a valid dotted hostname or URL (e.g. api.example.com or http://host.docker.internal:8000); got "${s}".`);
  return h;
}

router.get("/vault", async (req, res) => {
  const userId = uid(req);
  const creds = await listCredentials(userId);
  const conns = await db.select().from(connectorsTable).where(eq(connectorsTable.userId, userId));
  const mcps = await db.select().from(mcpServersTable).where(eq(mcpServersTable.userId, userId));
  const usedBy = new Map<number, { kind: "connector" | "mcp"; name: string; id: string | number }[]>();
  for (const c of conns) {
    if (!c.credentialId) continue;
    const arr = usedBy.get(c.credentialId) ?? [];
    arr.push({ kind: "connector", name: c.displayName, id: c.provider });
    usedBy.set(c.credentialId, arr);
  }
  for (const m of mcps) {
    if (!m.credentialId) continue;
    const arr = usedBy.get(m.credentialId) ?? [];
    arr.push({ kind: "mcp", name: m.name, id: m.id });
    usedBy.set(m.credentialId, arr);
  }
  res.json({
    logins: creds.map(({ surrogate: _s, ...c }) => ({
      ...c,
      hasSecret: true,
      usedBy: usedBy.get(c.id) ?? [],
    })),
  });
});

router.post("/vault", async (req, res) => {
  const userId = uid(req);
  const label = String(req.body?.label ?? "").trim().slice(0, 100);
  if (!label) {
    res.status(400).json({ error: "Label is required." });
    return;
  }
  let host: string;
  let username: string | null = null;
  try {
    host = parseVaultHost(req.body?.host ?? req.body?.baseUrl);
    if (req.body?.username != null && String(req.body.username).trim() !== "") {
      username = parseUsername(req.body.username);
    }
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }
  const secret =
    typeof req.body?.password === "string" && req.body.password.length > 0
      ? req.body.password
      : typeof req.body?.secret === "string" && req.body.secret.length > 0
        ? req.body.secret
        : "";
  if (!secret) {
    res.status(400).json({ error: "Password or token is required." });
    return;
  }
  const row = await storeCredential(userId, {
    label,
    kind: username ? "login" : "api_key",
    host,
    username,
    secret,
  });
  res.json({
    ok: true,
    login: {
      id: row.id,
      userId: row.userId,
      label: row.label,
      kind: row.kind,
      host: row.host,
      username: row.username,
      hasSecret: true,
      createdAt: row.createdAt,
    },
  });
});

router.patch("/vault/:id", async (req, res) => {
  const userId = uid(req);
  const id = idParam(req);
  const patch: { label?: string; host?: string | null; username?: string | null; secret?: string; kind?: string } = {};
  try {
    if (Object.hasOwn(req.body ?? {}, "label")) {
      const label = String(req.body.label ?? "").trim().slice(0, 100);
      if (!label) throw new Error("Label cannot be empty.");
      patch.label = label;
    }
    if (Object.hasOwn(req.body ?? {}, "host") || Object.hasOwn(req.body ?? {}, "baseUrl")) {
      patch.host = parseVaultHost(req.body.host ?? req.body.baseUrl);
    }
    if (Object.hasOwn(req.body ?? {}, "username")) {
      const rawUser = req.body.username;
      patch.username = rawUser != null && String(rawUser).trim() !== "" ? parseUsername(rawUser) : null;
      patch.kind = patch.username ? "login" : "api_key";
    }
    const secret =
      typeof req.body?.password === "string" && req.body.password.length > 0
        ? req.body.password
        : typeof req.body?.secret === "string" && req.body.secret.length > 0
          ? req.body.secret
          : undefined;
    if (secret !== undefined) patch.secret = secret;
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }
  const updated = await updateCredential(userId, id, patch);
  if (!updated) {
    res.status(404).json({ error: "Vault login not found." });
    return;
  }
  const usedByMcp = await db
    .select({ id: mcpServersTable.id })
    .from(mcpServersTable)
    .where(and(eq(mcpServersTable.userId, userId), eq(mcpServersTable.credentialId, id)));
  if (usedByMcp.length > 0) {
    invalidateMcpCache();
    await refreshMcpConnections(userId).catch(() => {});
  }
  res.json({ ok: true, login: { ...updated, hasSecret: true } });
});

router.delete("/vault/:id", async (req, res) => {
  await detachAndDeleteCredential(uid(req), idParam(req));
  res.json({ ok: true });
});

// ---------- MCP servers (owner-managed) ----------
function parseMcpServerUrl(raw: unknown): { url: string; host: string } {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("Server URL isn't a valid URL.");
  }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Server URL must start with http:// or https://");
  if (u.username || u.password) throw new Error("Server URL must not contain a username or password. Use a Vault login instead.");
  if (u.protocol === "http:" && !isPrivateHost(u.hostname)) {
    throw new Error("HTTP URLs are only allowed for local, LAN or tailnet addresses. Use HTTPS for public MCP servers.");
  }
  u.hash = "";
  return { url: u.href, host: u.hostname };
}

function parseMcpAuthHeader(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) throw new Error("Custom header template is required (e.g. X-Api-Key: {token}).");
  if (/[\x00-\x1f\x7f]/.test(s)) throw new Error("Header template must not contain control characters.");
  if (!s.includes(":")) {
    if (!/^[A-Za-z0-9-]+$/.test(s)) throw new Error(`Invalid header name "${s}".`);
    return `${s}: {token}`;
  }
  const idx = s.indexOf(":");
  const name = s.slice(0, idx).trim();
  if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error(`Invalid header name "${name}".`);
  const rest = s.slice(idx + 1).trim();
  if (!rest.includes("{token}")) throw new Error("Header template must contain {token} where the vault credential goes.");
  return `${name}: ${rest}`;
}

function parseAllowlistInput(raw: unknown): string[] | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (Array.isArray(raw)) {
    const cleaned = raw.map((x) => {
      if (typeof x !== "string") throw new Error("Allowlist entries must be strings.");
      return x.trim();
    }).filter(Boolean);
    return cleaned.length ? cleaned : null;
  }
  if (typeof raw === "string") {
    const cleaned = raw
      .split(/[\n,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    return cleaned.length ? cleaned : null;
  }
  throw new Error("Allowlist must be a list of tool names.");
}

async function validateMcpServerBody(
  userId: string,
  body: any,
  existing?: typeof mcpServersTable.$inferSelect,
): Promise<{
  name: string;
  transport: "http";
  url: string;
  authType: "none" | "bearer" | "custom";
  authHeader: string | null;
  credentialId: number | null;
  allowlist: string[] | null;
  enabled: boolean;
}> {
  const name = (Object.hasOwn(body, "name") ? String(body.name ?? "") : (existing?.name ?? "")).trim();
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(name)) {
    throw new Error("Name must be 1–60 characters using only letters, numbers, hyphens, or underscores.");
  }
  const transport = Object.hasOwn(body, "transport") ? String(body.transport ?? "http").toLowerCase() : (existing?.transport ?? "http");
  if (transport !== "http") throw new Error("Only HTTP transport is supported.");
  const rawUrl = Object.hasOwn(body, "url") ? body.url : existing?.url;
  const parsedUrl = parseMcpServerUrl(rawUrl);

  const authType = (Object.hasOwn(body, "authType") ? String(body.authType ?? "none") : (existing?.authType ?? "none")) as "none" | "bearer" | "custom";
  if (!["none", "bearer", "custom"].includes(authType)) throw new Error("Unknown authentication type.");

  let credentialId: number | null = null;
  let authHeader: string | null = null;
  if (authType !== "none") {
    assertCredentialHostRepresentable(parsedUrl.host);
    const credRaw = Object.hasOwn(body, "credentialId") ? body.credentialId : existing?.credentialId;
    const cid = Number(credRaw);
    if (!Number.isInteger(cid) || cid <= 0) throw new Error("Select a vault login for authentication.");
    const [found] = await db
      .select({ id: credentialsTable.id })
      .from(credentialsTable)
      .where(and(eq(credentialsTable.userId, userId), eq(credentialsTable.id, cid)));
    if (!found) throw new Error("Selected vault login was not found.");
    credentialId = cid;
    if (authType === "custom") {
      authHeader = parseMcpAuthHeader(Object.hasOwn(body, "authHeader") ? body.authHeader : existing?.authHeader);
    }
  }

  const allowlist = Object.hasOwn(body, "allowlist") ? parseAllowlistInput(body.allowlist) : (existing?.allowlist ?? null);
  const enabled = Object.hasOwn(body, "enabled") ? body.enabled !== false : (existing?.enabled ?? true);

  return { name, transport: "http", url: parsedUrl.url, authType, authHeader, credentialId, allowlist, enabled };
}

router.get("/mcp-servers", async (req, res) => {
  const userId = uid(req);
  const state = req.query.refresh === "1" ? await refreshMcpConnections(userId) : await getMcpState(userId);
  const rows = await db.select().from(mcpServersTable).where(eq(mcpServersTable.userId, userId)).orderBy(asc(mcpServersTable.id));
  const credMap = new Map((await listCredentials(userId)).map((c) => [c.id, c]));
  const statusById = new Map<number, (typeof state.statuses)[number]>();
  for (const s of state.statuses) if (s.id != null) statusById.set(s.id, s);

  res.json({
    usingBootstrap: state.usingBootstrap,
    servers: rows.map((r) => ({
      ...r,
      credentialLabel: r.credentialId ? (credMap.get(r.credentialId)?.label ?? null) : null,
      live: statusById.get(r.id) ?? null,
    })),
    bootstrapServers: state.usingBootstrap
      ? state.statuses
          .filter((s) => s.source === "env")
          .map((s) => ({
            name: s.name,
            transport: s.transport,
            url: s.url ?? null,
            allowlist: s.allowlist,
            enabled: s.enabled,
            status: s.status,
            error: s.error,
            offeredTools: s.offeredTools,
            discoveredTools: s.discoveredTools,
            toolNames: s.toolNames,
          }))
      : [],
  });
});

router.post("/mcp-servers", async (req, res) => {
  const userId = uid(req);
  let data: Awaited<ReturnType<typeof validateMcpServerBody>>;
  try {
    data = await validateMcpServerBody(userId, req.body ?? {});
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }
  const [dup] = await db
    .select({ id: mcpServersTable.id })
    .from(mcpServersTable)
    .where(and(eq(mcpServersTable.userId, userId), eq(mcpServersTable.name, data.name)));
  if (dup) {
    res.status(400).json({ error: `An MCP server named "${data.name}" already exists.` });
    return;
  }
  const [row] = await db
    .insert(mcpServersTable)
    .values({ userId, ...data })
    .returning();
  const state = await refreshMcpConnections(userId);
  const live = state.statuses.find((s) => s.id === row!.id) ?? null;
  res.json({ ok: true, server: { ...row, live } });
});

router.patch("/mcp-servers/:id", async (req, res) => {
  const userId = uid(req);
  const id = idParam(req);
  const [existing] = await db
    .select()
    .from(mcpServersTable)
    .where(and(eq(mcpServersTable.userId, userId), eq(mcpServersTable.id, id)));
  if (!existing) {
    res.status(404).json({ error: "MCP server not found." });
    return;
  }
  let data: Awaited<ReturnType<typeof validateMcpServerBody>>;
  try {
    data = await validateMcpServerBody(userId, req.body ?? {}, existing);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }
  if (data.name !== existing.name) {
    const [dup] = await db
      .select({ id: mcpServersTable.id })
      .from(mcpServersTable)
      .where(and(eq(mcpServersTable.userId, userId), eq(mcpServersTable.name, data.name), ne(mcpServersTable.id, id)));
    if (dup) {
      res.status(400).json({ error: `An MCP server named "${data.name}" already exists.` });
      return;
    }
  }
  const [updated] = await db
    .update(mcpServersTable)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(mcpServersTable.userId, userId), eq(mcpServersTable.id, id)))
    .returning();
  const state = await refreshMcpConnections(userId);
  const live = state.statuses.find((s) => s.id === updated!.id) ?? null;
  res.json({ ok: true, server: { ...updated, live } });
});

router.delete("/mcp-servers/:id", async (req, res) => {
  const userId = uid(req);
  const id = idParam(req);
  await db.delete(mcpServersTable).where(and(eq(mcpServersTable.userId, userId), eq(mcpServersTable.id, id)));
  await refreshMcpConnections(userId);
  res.json({ ok: true });
});

router.post("/mcp-servers/refresh", async (req, res) => {
  const userId = uid(req);
  const state = await refreshMcpConnections(userId);
  res.json({ ok: true, statuses: state.statuses, usingBootstrap: state.usingBootstrap });
});

// ---------- browser ----------
router.get("/browser/:id", async (req, res) => {
  const [s] = await db
    .select()
    .from(browserSessionsTable)
    .where(and(eq(browserSessionsTable.id, idParam(req)), eq(browserSessionsTable.userId, uid(req))));
  res.json({ session: s ?? null });
});

router.post("/browser/:id/control", async (req, res) => {
  res.json(await controlSession(uid(req), idParam(req), req.body ?? {}));
});

// ---------- voice ----------
let whisperWarmed = false;

/** A 1-second silent WAV (16 kHz mono PCM) used to force the transcription model to load. */
function silentWav(): Buffer {
  const samples = 16000;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

router.post("/voice/warm", async (_req, res) => {
  // Fire-and-forget: load the Whisper model now so the first real transcription in a call
  // doesn't pay the cold-start reload. Never blocks or fails the client.
  if (!whisperWarmed) {
    void (async () => {
      try {
        const file = new File([silentWav()], "warm.wav", { type: "audio/wav" });
        await transcribeOpenai.audio.transcriptions.create({ model: MODELS.transcribe, file });
        whisperWarmed = true;
      } catch {}
    })();
  }
  res.json({ ok: true });
});

router.post("/voice/transcribe", async (req, res) => {
  const userId = uid(req);
  const b64 = String(req.body?.audio ?? "");
  const mime = String(req.body?.mime ?? "audio/webm");
  if (!b64) {
    res.status(400).end();
    return;
  }
  const buf = Buffer.from(b64, "base64");
  const ext = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
  const file = new File([buf], `speech.${ext}`, { type: mime });
  try {
    const r = await transcribeOpenai.audio.transcriptions.create({ model: MODELS.transcribe, file });
    await record(userId, { audioSeconds: Math.max(1, Math.round(buf.length / 16000)) });
    res.json({ text: r.text });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

router.post("/voice/speak", async (req, res) => {
  const userId = uid(req);
  const text = String(req.body?.text ?? "").slice(0, 2000);
  const voice = String(req.body?.voice ?? "alloy");
  if (!text.trim()) {
    res.status(400).json({ error: "Nothing to say" });
    return;
  }
  try {
    const audio = await synthesizeSpeech(text, voice);
    await record(userId, { audioSeconds: speechSeconds(text) });
    res.setHeader("Content-Type", "audio/wav");
    res.send(audio);
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

export default router;
