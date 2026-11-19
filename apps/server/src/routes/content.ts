import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { artifactsTable, browserSessionsTable, connectorsTable, db, messagesTable, scheduledTasksTable, spacesTable } from "@amuse/db";
import { publish } from "../agent/bus";
import { SANDBOX_CSP } from "../agent/sentinel";
import { API_PRESETS, CATALOG } from "../agent/connectors";
import { activeRunFor, startRun, steer } from "../agent/loop";
import { controlSession } from "../agent/tools/browser";
import { postEvent } from "../agent/tools/connectors";
import { record } from "../agent/usage";
import { getMainChatId } from "../agent/workspace";
import { MODELS, openai, speechSeconds, synthesizeSpeech } from "../lib/ai";
import { confirmCredentialDestination, deleteCredential, isAuthHeader, listCredentials, storeCredential } from "../lib/vault";
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
  res.json({ catalog: CATALOG, connected: rows.map((r) => ({ ...r, config: { ...(r.config as any), password: undefined } })) });
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
  const patch: Record<string, unknown> = {};
  if (["read", "readwrite"].includes(req.body?.access)) patch.access = req.body.access;
  if (["some", "always"].includes(req.body?.approvalMode)) patch.approvalMode = req.body.approvalMode;
  await db
    .update(connectorsTable)
    .set(patch)
    .where(and(eq(connectorsTable.userId, uid(req)), eq(connectorsTable.provider, String(req.params.provider))));
  res.json({ ok: true });
});

router.delete("/connectors/:provider", async (req, res) => {
  const userId = uid(req);
  const [c] = await db
    .select()
    .from(connectorsTable)
    .where(and(eq(connectorsTable.userId, userId), eq(connectorsTable.provider, String(req.params.provider))));
  if (c?.credentialId) await deleteCredential(userId, c.credentialId);
  await db.delete(connectorsTable).where(and(eq(connectorsTable.userId, userId), eq(connectorsTable.provider, String(req.params.provider))));
  res.json({ ok: true });
});

// ---------- credentials (secure store) ----------
router.get("/credentials", async (req, res) => {
  res.json({ credentials: (await listCredentials(uid(req))).map(({ surrogate: _s, ...c }) => c) });
});

router.post("/credentials", async (req, res) => {
  const userId = uid(req);
  const { label, host, username, secret, baseUrl, header, chatId: rawChat } = req.body ?? {};
  if (!label || !secret) {
    res.status(400).json({ error: "Label and secret are required" });
    return;
  }
  let destination: string;
  try {
    destination = confirmCredentialDestination(String(label), host, baseUrl, req.body?.confirmedHost);
    if (baseUrl && new URL(baseUrl).protocol !== "https:") throw new Error("Credential API destinations must use HTTPS.");
    if (header && !isAuthHeader(String(header).split(":")[0]!.trim())) throw new Error("Credentials must use an authentication header.");
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }
  const cred = await storeCredential(userId, { label, host: destination, username, secret, kind: username ? "login" : "api_key" });
  let note = `Credential saved securely: "${label}", bound to ${destination}. Use surrogate token ${cred.surrogate} only in API authentication headers or browser password/credential fields, never URLs or bodies. First use requires approval.`;
  if (baseUrl) {
    const provider =
      "custom-" +
      String(label)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 30);
    await db
      .insert(connectorsTable)
      .values({
        userId,
        provider,
        displayName: label,
        custom: true,
        access: "readwrite",
        config: { baseUrl, header: header ?? "Authorization: Bearer {token}" },
        credentialId: cred.id,
      })
      .onConflictDoUpdate({
        target: [connectorsTable.userId, connectorsTable.provider],
        set: { config: { baseUrl, header: header ?? "Authorization: Bearer {token}" }, credentialId: cred.id },
      });
    note += ` Custom connector "${provider}" created for ${baseUrl}; call it with api_request (auth header added automatically).`;
  }
  const chatId = rawChat ? Number(rawChat) : await getMainChatId(userId);
  await postEvent(userId, chatId, note);
  if (!activeRunFor(chatId)) await startRun({ userId, chatId, trigger: "event" });
  res.json({ ok: true });
});

router.delete("/credentials/:id", async (req, res) => {
  await deleteCredential(uid(req), idParam(req));
  res.json({ ok: true });
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
router.post("/voice/warm", async (_req, res) => {
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
    const r = await openai.audio.transcriptions.create({ model: MODELS.transcribe, file });
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
    const mp3 = await synthesizeSpeech(text, voice);
    await record(userId, { audioSeconds: speechSeconds(text) });
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(mp3);
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

export default router;
