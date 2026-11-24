import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db, mcpServersTable } from "@amuse/db";
import { check, markUntrustedRead } from "./sentinel";
import { logger } from "../lib/logger";
import type { McpServerConfig } from "../lib/config";
import { mcpServers } from "../lib/config";
import { redactSecrets, resolveVaultAuthHeader } from "../lib/vault";
import { OWNER_ID } from "../middlewares/owner";
import type { ToolDef } from "./tools/types";

/**
 * A small, dependency-free MCP client + registry.
 *
 * Servers are operator-configured (AMUSE_MCP_SERVERS, JSON). On the first agent run the
 * registry connects to each enabled server, discovers its tools, and offers them to the
 * model as ordinary tools named mcp__<server>__<tool>. Every call passes the sentinel:
 * tools the server annotates readOnlyHint are class "read"; everything else is "write"
 * (asks by default), and destructiveHint forces an ask every time. Results are untrusted
 * data, like every other external tool.
 */

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

const PROTOCOL_VERSION = "2025-03-26";
const REQUEST_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;

function rpcError(prefix: string, e: unknown): Error {
  return new Error(`${prefix}: ${e instanceof Error ? e.message : String(e)}`);
}

class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private headers: Record<string, string>;

  constructor(private cfg: McpServerConfig) {
    this.headers = { ...(cfg.headers ?? {}) };
    for (const [k, v] of Object.entries(this.headers)) {
      const m = /^\$env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(v.trim());
      if (m) this.headers[k] = process.env[m[1]!] ?? "";
    }
  }

  private async post(payload: unknown, isNotification = false, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await fetch(this.cfg.url!, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (isNotification) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} from MCP server ${this.cfg.name}`);
    const text = await res.text();
    if (!text.trim()) return null;
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("text/event-stream")) {
      // SSE: find the JSON-RPC message among the data: lines.
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data) continue;
        try {
          const msg = JSON.parse(data);
          if (msg && typeof msg === "object" && ("result" in msg || "error" in msg)) return msg;
        } catch {}
      }
      throw new Error(`No JSON-RPC response in SSE stream from ${this.cfg.name}`);
    }
    return JSON.parse(text);
  }

  private async request(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    const id = this.nextId++;
    const msg = await this.post({ jsonrpc: "2.0", id, method, params }, false, timeoutMs);
    if (!msg) throw new Error(`Empty response to ${method} from ${this.cfg.name}`);
    if (msg.error) throw new Error(`MCP ${method} error from ${this.cfg.name}: ${JSON.stringify(msg.error).slice(0, 500)}`);
    return msg.result;
  }

  async initialize(): Promise<void> {
    await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "amuse", version: "0.1.0" },
      },
      CONNECT_TIMEOUT_MS,
    );
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, true, CONNECT_TIMEOUT_MS).catch(() => {});
  }

  async listTools(): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.request("tools/list", cursor ? { cursor } : {}, CONNECT_TIMEOUT_MS);
      out.push(...((r?.tools ?? []) as McpToolInfo[]));
      cursor = r?.nextCursor;
    } while (cursor);
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    return this.request("tools/call", { name, arguments: args });
  }
}

class McpStdioClient {
  private proc: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  dead = false;

  constructor(private cfg: McpServerConfig) {
    this.proc = spawn(cfg.command!, cfg.args ?? [], {
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr!.setEncoding("utf8");
    this.proc.stderr!.on("data", () => {}); // drain; server logs are not agent data
    this.proc.on("exit", () => {
      this.dead = true;
      for (const p of this.pending.values()) p.reject(new Error(`MCP server ${cfg.name} exited`));
      this.pending.clear();
      invalidateMcpCache();
    });
    this.proc.on("error", (e) => {
      this.dead = true;
      for (const p of this.pending.values()) p.reject(rpcError(`MCP server ${cfg.name} failed to start`, e));
      this.pending.clear();
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`MCP error from ${this.cfg.name}: ${JSON.stringify(msg.error).slice(0, 500)}`));
        else p.resolve(msg.result);
      }
    }
  }

  private send(payload: unknown) {
    this.proc.stdin!.write(JSON.stringify(payload) + "\n");
  }

  private async request(method: string, params?: unknown): Promise<any> {
    if (this.dead) throw new Error(`MCP server ${this.cfg.name} is not running`);
    const id = this.nextId++;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.dead = true;
        reject(new Error(`MCP ${method} to ${this.cfg.name} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "amuse", version: "0.1.0" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.request("tools/list", cursor ? { cursor } : {});
      out.push(...((r?.tools ?? []) as McpToolInfo[]));
      cursor = r?.nextCursor;
    } while (cursor);
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    return this.request("tools/call", { name, arguments: args });
  }
}

type McpClient = McpHttpClient | McpStdioClient;

const clients = new Map<string, McpClient>();

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function mcpToolName(server: string, tool: string): string {
  const prefix = `mcp__${sanitize(server)}__`;
  let t = sanitize(tool);
  if (prefix.length + t.length > 64) {
    const hash = createHash("sha256").update(tool).digest("hex").slice(0, 6);
    t = `${t.slice(0, 64 - prefix.length - 7)}_${hash}`;
  }
  return prefix + t;
}

export function toolAllowed(allowlist: string[] | undefined | null, toolName: string): boolean {
  if (!allowlist) return true;
  return allowlist.some((p) => (p.endsWith("*") ? toolName.startsWith(p.slice(0, -1)) : toolName === p));
}

function flattenResult(result: any): { text: string; isError: boolean } {
  if (!result || typeof result !== "object") return { text: String(result ?? ""), isError: false };
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item?.type === "text") parts.push(String(item.text ?? ""));
      else parts.push(JSON.stringify(item));
    }
  }
  if (result.structuredContent !== undefined && !parts.length) parts.push(JSON.stringify(result.structuredContent));
  if (!parts.length) parts.push(JSON.stringify(result));
  return { text: parts.join("\n"), isError: result.isError === true };
}

/** Amuse's validateArgs speaks plain JSON types; MCP schemas commonly say "integer". Normalize deeply. */
function normalizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeSchema);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = k === "type" && v === "integer" ? "number" : normalizeSchema(v);
    }
    return out;
  }
  return node;
}

function toToolDef(cfg: McpServerConfig, client: McpClient, info: McpToolInfo): ToolDef {
  const readOnly = info.annotations?.readOnlyHint === true;
  const destructive = info.annotations?.destructiveHint === true;
  const schema =
    info.inputSchema && typeof info.inputSchema === "object" && (info.inputSchema as any).type === "object"
      ? (normalizeSchema(info.inputSchema) as Record<string, unknown>)
      : { type: "object", properties: {}, additionalProperties: true };
  return {
    name: mcpToolName(cfg.name, info.name),
    skill: `MCP · ${cfg.name}`,
    status: `Using ${info.name}`,
    description: `[MCP server "${cfg.name}"] ${info.description ?? info.name}`,
    parameters: schema,
    async run(args, ctx) {
      const ok = await check({
        userId: ctx.userId,
        runId: ctx.runId,
        chatId: ctx.chatId,
        toolName: mcpToolName(cfg.name, info.name),
        actionClass: readOnly ? "read" : "write",
        target: cfg.name,
        purpose: `Call ${info.name} on ${cfg.name}`,
        details: { server: cfg.name, tool: info.name, arguments: args },
        forceAsk: destructive,
        connectorMode: "some",
      });
      if (ok === "deny") return { error: `The person denied the ${info.name} call.` };
      markUntrustedRead(ctx.runId);
      let raw: any;
      try {
        raw = await client.callTool(info.name, args ?? {});
      } catch (e) {
        invalidateMcpCache();
        return { error: `MCP call failed: ${(e as Error).message}` };
      }
      const { text, isError } = flattenResult(raw);
      await ctx.activity("tool", `MCP ${cfg.name}/${info.name} → ${isError ? "error" : "ok"}`, { server: cfg.name, tool: info.name }, `MCP · ${cfg.name}`);
      if (isError) return { untrusted_data: true, error: text.slice(0, 8000) };
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {}
      return { untrusted_data: true, result: parsed };
    },
  };
}

export interface McpServerStatus {
  id?: number;
  name: string;
  source: "db" | "env";
  url?: string;
  transport: "http" | "stdio";
  enabled: boolean;
  allowlist: string[] | null;
  status: "connected" | "failed" | "disabled";
  error: string | null;
  offeredTools: number;
  discoveredTools: number;
  toolNames: string[];
  checkedAt: string;
}

export interface ConnectedMcpServer {
  name: string;
  source: "db" | "env";
  id?: number;
  allowlist: string[] | null;
  client: McpClient;
  offeredInfos: McpToolInfo[];
  discoveredCount: number;
  defs: ToolDef[];
  byRawName: Map<string, ToolDef>;
}

export interface McpRegistryState {
  tools: ToolDef[];
  byName: Map<string, ToolDef>;
  servers: Map<string, ConnectedMcpServer>;
  statuses: McpServerStatus[];
  usingBootstrap: boolean;
}

interface EffectiveMcpConfig extends McpServerConfig {
  id?: number;
  source: "db" | "env";
  authType?: "none" | "bearer" | "custom";
  authHeader?: string | null;
  credentialId?: number | null;
}

let cache: { userId: string; state: McpRegistryState } | null = null;
let connecting: { userId: string; promise: Promise<McpRegistryState> } | null = null;

export function invalidateMcpCache() {
  cache = null;
  connecting = null;
}

async function loadEffectiveConfigs(userId: string): Promise<{ configs: EffectiveMcpConfig[]; usingBootstrap: boolean }> {
  let dbRows: (typeof mcpServersTable.$inferSelect)[] = [];
  try {
    dbRows = await db.select().from(mcpServersTable).where(eq(mcpServersTable.userId, userId)).orderBy(asc(mcpServersTable.id));
  } catch {
    dbRows = [];
  }
  if (dbRows.length > 0) {
    return {
      usingBootstrap: false,
      configs: dbRows.map((r) => ({
        id: r.id,
        name: r.name,
        source: "db",
        transport: (r.transport === "stdio" ? "stdio" : "http") as "http" | "stdio",
        url: r.url,
        enabled: r.enabled,
        allowlist: Array.isArray(r.allowlist) && r.allowlist.length > 0 ? r.allowlist : undefined,
        authType: (r.authType === "bearer" || r.authType === "custom" ? r.authType : "none") as "none" | "bearer" | "custom",
        authHeader: r.authHeader,
        credentialId: r.credentialId,
      })),
    };
  }
  return {
    usingBootstrap: true,
    configs: mcpServers.map((s) => ({
      ...s,
      source: "env",
      allowlist: Array.isArray(s.allowlist) && s.allowlist.length > 0 ? s.allowlist : undefined,
    })),
  };
}

async function safeErrorMessage(userId: string, e: unknown): Promise<string> {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    return (await redactSecrets(userId, raw)).slice(0, 300);
  } catch {
    return raw.slice(0, 300);
  }
}

async function connectAll(userId: string): Promise<McpRegistryState> {
  const { configs, usingBootstrap } = await loadEffectiveConfigs(userId);
  const tools: ToolDef[] = [];
  const byName = new Map<string, ToolDef>();
  const servers = new Map<string, ConnectedMcpServer>();
  const statuses: McpServerStatus[] = [];

  clients.clear();

  for (const cfg of configs) {
    const checkedAt = new Date().toISOString();
    const allowlist = cfg.allowlist ?? null;
    if (cfg.enabled === false) {
      statuses.push({
        id: cfg.id,
        name: cfg.name,
        source: cfg.source,
        url: cfg.url,
        transport: cfg.transport,
        enabled: false,
        allowlist,
        status: "disabled",
        error: null,
        offeredTools: 0,
        discoveredTools: 0,
        toolNames: [],
        checkedAt,
      });
      continue;
    }

    try {
      let resolvedCfg: McpServerConfig = cfg;
      if (cfg.source === "db" && (cfg.authType === "bearer" || cfg.authType === "custom")) {
        if (!cfg.credentialId) throw new Error("No vault login configured for server authentication.");
        const destHost = new URL(cfg.url!).hostname;
        const auth = await resolveVaultAuthHeader(userId, cfg.credentialId, destHost, cfg.authType, cfg.authHeader);
        resolvedCfg = { ...cfg, headers: { ...(cfg.headers ?? {}), [auth.name]: auth.value } };
      }

      const client: McpClient = resolvedCfg.transport === "stdio" ? new McpStdioClient(resolvedCfg) : new McpHttpClient(resolvedCfg);
      await client.initialize();
      const infos = await client.listTools();
      clients.set(cfg.name, client);

      const offered = infos.filter((info) => toolAllowed(cfg.allowlist, info.name));
      const defs: ToolDef[] = [];
      const byRawName = new Map<string, ToolDef>();
      for (const info of offered) {
        const def = toToolDef(resolvedCfg, client, info);
        tools.push(def);
        byName.set(def.name, def);
        defs.push(def);
        byRawName.set(info.name, def);
      }

      servers.set(cfg.name, {
        name: cfg.name,
        source: cfg.source,
        id: cfg.id,
        allowlist,
        client,
        offeredInfos: offered,
        discoveredCount: infos.length,
        defs,
        byRawName,
      });

      statuses.push({
        id: cfg.id,
        name: cfg.name,
        source: cfg.source,
        url: cfg.url,
        transport: cfg.transport,
        enabled: true,
        allowlist,
        status: "connected",
        error: null,
        offeredTools: offered.length,
        discoveredTools: infos.length,
        toolNames: offered.map((i) => i.name),
        checkedAt,
      });

      logger.info(
        cfg.allowlist
          ? { server: cfg.name, source: cfg.source, tools: offered.length, discovered: infos.length }
          : { server: cfg.name, source: cfg.source, tools: offered.length },
        "mcp server connected",
      );
    } catch (e) {
      let errMsg = await safeErrorMessage(userId, e);
      try {
        if (cfg.url && new URL(cfg.url).hostname.toLowerCase().endsWith(".local")) {
          const hint = "(.local mDNS does not route from Docker; use the Tailscale .ts.net hostname instead)";
          if (!errMsg.includes(".ts.net")) errMsg = `${errMsg} ${hint}`.slice(0, 300);
        }
      } catch {}
      statuses.push({
        id: cfg.id,
        name: cfg.name,
        source: cfg.source,
        url: cfg.url,
        transport: cfg.transport,
        enabled: true,
        allowlist,
        status: "failed",
        error: errMsg,
        offeredTools: 0,
        discoveredTools: 0,
        toolNames: [],
        checkedAt,
      });
      logger.warn({ server: cfg.name, source: cfg.source, err: errMsg }, "mcp server unavailable; skipping");
    }
  }
  return { tools, byName, servers, statuses, usingBootstrap };
}

/** Discovered MCP state, connected lazily on first use and cached until invalidated. */
export async function getMcpState(userId = OWNER_ID): Promise<McpRegistryState> {
  if (cache && cache.userId === userId) return cache.state;
  if (!connecting || connecting.userId !== userId) {
    const promise = connectAll(userId).then(
      (state) => {
        cache = { userId, state };
        if (connecting?.promise === promise) connecting = null;
        return state;
      },
      (err) => {
        if (connecting?.promise === promise) connecting = null;
        throw err;
      },
    );
    connecting = { userId, promise };
  }
  return connecting.promise;
}

/** Force reconnect and re-discover all configured MCP servers. */
export async function refreshMcpConnections(userId = OWNER_ID): Promise<McpRegistryState> {
  invalidateMcpCache();
  return getMcpState(userId);
}

/** Discovered MCP tools, connected lazily on first use and cached for the process. */
export async function getMcpTools(userId = OWNER_ID): Promise<ToolDef[]> {
  return (await getMcpState(userId)).tools;
}

export async function lookupMcpTool(name: string, userId = OWNER_ID): Promise<ToolDef | undefined> {
  const state = await getMcpState(userId);
  return state.byName.get(name);
}

export async function callRawMcpTool(
  serverName: string,
  rawToolName: string,
  args: Record<string, unknown>,
  userId = OWNER_ID,
): Promise<{ text: string; isError: boolean; parsed: unknown }> {
  const findServer = (state: McpRegistryState) => {
    const target = serverName.toLowerCase();
    for (const [k, v] of state.servers.entries()) {
      if (k.toLowerCase() === target) return v;
    }
    return undefined;
  };
  let state = await getMcpState(userId);
  let srv = findServer(state);
  if (!srv) throw new Error(`MCP server "${serverName}" is not connected.`);
  let raw: any;
  try {
    raw = await srv.client.callTool(rawToolName, args ?? {});
  } catch (e) {
    invalidateMcpCache();
    state = await getMcpState(userId);
    srv = findServer(state);
    if (!srv) throw e;
    raw = await srv.client.callTool(rawToolName, args ?? {});
  }
  const { text, isError } = flattenResult(raw);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { text, isError, parsed };
}
