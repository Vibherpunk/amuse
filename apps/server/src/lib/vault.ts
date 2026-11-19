import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { approvalsTable, connectorsTable, credentialsTable, db } from "@amuse/db";
import { secretKey } from "./config";

/**
 * Secure credential store. Secrets are AES-256-GCM encrypted at rest.
 * The model only ever sees a surrogate token (amuse_sur_xxx); real values are
 * swapped in at the egress boundary by api_request or credential-field browser fills.
 */
function key(): Buffer {
  return crypto
    .createHash("sha256")
    .update("amuse-vault:" + secretKey)
    .digest();
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64")).join(".");
}

export function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  if (iv?.length !== 12 || tag?.length !== 16) throw new Error("Malformed encrypted value");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv, { authTagLength: 16 });
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(enc!), decipher.final()]).toString("utf8");
}

/** "https://api.github.com/v1" or "www.GitHub.com" -> "github.com"-style host, or null if it isn't a hostname. */
export function normalizeHost(value?: string | null): string | null {
  if (!value) return null;
  let h = String(value).trim().toLowerCase();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(h)) h = new URL(h).hostname;
  } catch {
    return null;
  }
  h = h.split("/")[0]!.split(":")[0]!.replace(/\.$/, "");
  return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(h) ? h : null;
}

export async function storeCredential(userId: string, input: { label: string; kind?: string; host?: string | null; username?: string | null; secret: string }) {
  const surrogate = "amuse_sur_" + crypto.randomBytes(12).toString("hex");
  const [row] = await db
    .insert(credentialsTable)
    .values({
      userId,
      label: input.label,
      kind: input.kind ?? "api_key",
      host: normalizeHost(input.host) ?? input.host ?? null,
      username: input.username ?? null,
      secretEnc: encrypt(input.secret),
      surrogate,
    })
    .returning();
  return row!;
}

export async function listCredentials(userId: string) {
  const rows = await db.select().from(credentialsTable).where(eq(credentialsTable.userId, userId));
  return rows.map(({ secretEnc: _s, ...r }) => r);
}

export async function deleteCredential(userId: string, id: number) {
  await db.delete(credentialsTable).where(and(eq(credentialsTable.userId, userId), eq(credentialsTable.id, id)));
}

/** The hosts a credential may be sent to: its own host plus the base URL of any connector that uses it. */
async function credentialHosts(userId: string, row: typeof credentialsTable.$inferSelect): Promise<string[]> {
  const hosts = new Set<string>();
  const own = normalizeHost(row.host);
  if (own) hosts.add(own);
  const conns = await db
    .select()
    .from(connectorsTable)
    .where(and(eq(connectorsTable.userId, userId), eq(connectorsTable.credentialId, row.id)));
  for (const c of conns) {
    const h = normalizeHost(typeof c.config.baseUrl === "string" ? c.config.baseUrl : null);
    if (h) hosts.add(h);
  }
  return [...hosts];
}

export const hostMatches = (dest: string, allowed: string) => dest === allowed;

const SERVICE_HOSTS: Record<string, string> = {
  github: "api.github.com",
  openai: "api.openai.com",
  notion: "api.notion.com",
  slack: "slack.com",
  stripe: "api.stripe.com",
  google: "googleapis.com",
  linear: "api.linear.app",
  todoist: "api.todoist.com",
  airtable: "api.airtable.com",
  trello: "api.trello.com",
};

const SERVICE_PATTERNS = Object.entries(SERVICE_HOSTS).map(([service, official]) => ({ service, official, pattern: new RegExp(`\\b${service}\\b`, "i") }));

export function credentialDestination(label: string, host?: string | null, baseUrl?: string | null): string {
  const destination = normalizeHost(baseUrl || host);
  if (!destination) throw new Error("A valid credential destination host is required.");
  if (host && baseUrl && normalizeHost(host) !== destination) throw new Error("Host and API base URL must name the same destination.");
  for (const { service, official, pattern } of SERVICE_PATTERNS) {
    if (pattern.test(label) && destination !== official && !destination.endsWith("." + official)) {
      throw new Error(`${service} credentials must use ${official}, not ${destination}.`);
    }
  }
  return destination;
}

export const isAuthHeader = (name: string) => /^(authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token|x-access-token)$/i.test(name);

export function credentialPlacementError(url: string, body: string | undefined, headers: Record<string, string>): string | null {
  if (url.includes("amuse_sur_") || body?.includes("amuse_sur_"))
    return "Credential tokens may only be placed in authentication headers, never URLs or bodies.";
  if (Object.entries(headers).some(([name, value]) => authHeaderText(value).includes("amuse_sur_") && !isAuthHeader(name)))
    return "Credential tokens may only be placed in authentication headers.";
  return null;
}

export function confirmCredentialDestination(label: string, host: string | null, baseUrl: string | null, confirmedHost: unknown): string {
  const destination = credentialDestination(label, host, baseUrl);
  if (confirmedHost !== destination) throw new Error("Confirm the exact destination host before saving.");
  return destination;
}

export function redactSecretForms(text: string, secret: string, replacement: string): string {
  if (!secret) return text;
  const encoded = encodeURIComponent(secret);
  text = text.replace(/[A-Za-z0-9+/_-]{8,}={0,2}/g, (candidate) => {
    const decoded = Buffer.from(candidate, "base64").toString("utf8");
    return decoded.includes(secret) ? replacement : candidate;
  });
  for (const form of new Set([
    secret,
    encoded,
    encoded.replace(/%[0-9A-F]{2}/g, (s) => s.toLowerCase()),
    new URLSearchParams({ s: secret }).toString().slice(2),
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("base64url"),
  ])) {
    text = text.split(form).join(replacement);
  }
  return text;
}

export function authHeaderText(value: string): string {
  return /^Basic /i.test(value) ? Buffer.from(value.slice(6), "base64").toString("utf8") : value;
}

export async function substituteAuthHeader(userId: string, value: string, host: string) {
  const result = await substituteSurrogates(userId, authHeaderText(value), host);
  return { ...result, text: /^Basic /i.test(value) ? "Basic " + Buffer.from(result.text).toString("base64") : result.text };
}

export async function unapprovedCredentialIds(userId: string, text: string): Promise<number[]> {
  const rows = await db.select().from(credentialsTable).where(eq(credentialsTable.userId, userId));
  const approvals = await db
    .select()
    .from(approvalsTable)
    .where(and(eq(approvalsTable.userId, userId), eq(approvalsTable.status, "allowed")));
  return rows
    .filter((r) =>
      credentialNeedsApproval(
        r.id,
        r.surrogate,
        text,
        approvals.map((a) => a.details.credentialIds),
      ),
    )
    .map((r) => r.id);
}

export function credentialNeedsApproval(id: number, surrogate: string, text: string, approvedIds: unknown[]): boolean {
  return text.includes(surrogate) && !approvedIds.some((ids) => Array.isArray(ids) && ids.includes(id));
}

/**
 * Replace surrogate tokens with real secrets, only at egress and only for the credential's own
 * website: a token bound to github.com is never swapped into a request to any other host.
 */
export async function substituteSurrogates(userId: string, text: string, destination: string | null): Promise<{ text: string; used: string[] }> {
  if (!text.includes("amuse_sur_")) return { text, used: [] };
  const dest = normalizeHost(destination);
  const rows = await db.select().from(credentialsTable).where(eq(credentialsTable.userId, userId));
  let out = text;
  const used: string[] = [];
  for (const r of rows) {
    if (!out.includes(r.surrogate)) continue;
    const hosts = await credentialHosts(userId, r);
    if (!dest || !hosts.some((h) => hostMatches(dest, h))) {
      throw new Error(
        `"${r.label}" can only be sent to ${hosts.length ? hosts.join(", ") : "the website it was saved for"}, not ${dest ?? "this destination"}.`,
      );
    }
    out = out.split(r.surrogate).join(decrypt(r.secretEnc));
    used.push(r.label);
  }
  return { text: out, used };
}

export async function getSecretById(userId: string, id: number): Promise<string | null> {
  const [row] = await db
    .select()
    .from(credentialsTable)
    .where(and(eq(credentialsTable.userId, userId), eq(credentialsTable.id, id)));
  return row ? decrypt(row.secretEnc) : null;
}

/** Strip any real secret values that might leak into model-visible text. */
export async function redactSecrets(userId: string, text: string): Promise<string> {
  const rows = await db.select().from(credentialsTable).where(eq(credentialsTable.userId, userId));
  let out = text;
  for (const r of rows) {
    const s = decrypt(r.secretEnc);
    out = redactSecretForms(out, s, r.surrogate);
  }
  return out;
}
