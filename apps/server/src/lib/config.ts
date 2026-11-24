import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Your OpenAI key runs everything: the agent, image generation, transcription and spoken replies. */
export const openaiApiKey = process.env.OPENAI_API_KEY ?? "";
/** Optional: an OpenAI-compatible endpoint or proxy. */
export const openaiBaseUrl = process.env.OPENAI_BASE_URL || undefined;

/** Optional: separate OpenAI-compatible endpoint for audio (speech + transcription), e.g. a local Speaches server. */
export const audioBaseUrl = process.env.AMUSE_AUDIO_BASE_URL || undefined;
/** Key for the audio endpoint (local servers usually ignore it). */
export const audioApiKey = process.env.AMUSE_AUDIO_API_KEY || "local";
/** Voice lane switch (Kyutai full-stack wiring, 2026-11-21). "current" (the
 *  default, and the behavior for any unset/unrecognized value) keeps the
 *  existing Speaches transcription + Pocket TTS speech endpoints exactly as
 *  configured below. "kyutai" routes BOTH speech and transcription to the
 *  Kyutai adapter on the host (~/kyutai-stack/adapter.py, launchd
 *  ai.kyutai.adapter, 127.0.0.1:8084), which fronts Kyutai STT
 *  (ws://127.0.0.1:8082/api/asr-streaming) and Kyutai TTS 1.6B
 *  (http://127.0.0.1:8083). Flip: set AMUSE_VOICE_LANE=kyutai in
 *  docker-compose.override.yml and recreate the amuse container. */
export const voiceLane = (process.env.AMUSE_VOICE_LANE || "current").trim().toLowerCase();
export const kyutaiBaseUrl = process.env.AMUSE_KYUTAI_BASE_URL || "http://host.docker.internal:8084/v1";
/** Optional: separate endpoint for speech synthesis only (e.g. Pocket TTS); falls back to the audio endpoint. */
export const speechBaseUrl = voiceLane === "kyutai" ? kyutaiBaseUrl : process.env.AMUSE_SPEECH_BASE_URL || audioBaseUrl;
export const speechApiKey = process.env.AMUSE_SPEECH_API_KEY || audioApiKey;
/** Optional: separate endpoint for transcription only (e.g. Speaches); falls back to the audio endpoint. */
export const transcribeBaseUrl = voiceLane === "kyutai" ? kyutaiBaseUrl : process.env.AMUSE_TRANSCRIBE_BASE_URL || audioBaseUrl;
export const transcribeApiKey = process.env.AMUSE_TRANSCRIBE_API_KEY || audioApiKey;
/** Optional: separate OpenAI-compatible endpoint for image generation, e.g. a local image shim. */
export const imageBaseUrl = process.env.AMUSE_IMAGE_BASE_URL || undefined;
/** Key for the image endpoint (local servers usually ignore it). */
export const imageApiKey = process.env.AMUSE_IMAGE_API_KEY || "local";

/** Maps Amuse/OpenAI voice names to the audio provider's own voices (e.g. Kokoro voices on Speaches). JSON object in env. */
function loadVoiceMap(): Record<string, string> {
  try {
    return process.env.AMUSE_SPEECH_VOICE_MAP ? JSON.parse(process.env.AMUSE_SPEECH_VOICE_MAP) : {};
  } catch {
    return {};
  }
}
export const speechVoiceMap = loadVoiceMap();

export const MODELS = {
  agent: process.env.AMUSE_AGENT_MODEL ?? "gpt-6.2-sol",
  fast: process.env.AMUSE_FAST_MODEL ?? "gpt-6-luna",
  image: process.env.AMUSE_IMAGE_MODEL ?? "gpt-image-2",
  transcribe: process.env.AMUSE_TRANSCRIBE_MODEL ?? (voiceLane === "kyutai" ? "kyutai-stt-1b-en_fr" : "gpt-4o-mini-transcribe"),
  speech: process.env.AMUSE_SPEECH_MODEL ?? (voiceLane === "kyutai" ? "kyutai-tts-1.6b-en_fr" : "gpt-4o-mini-tts"),
};

/** Where Amuse keeps local state that isn't in Postgres (the vault key). */
export const dataDir = path.resolve(process.env.AMUSE_DATA_DIR ?? path.join(import.meta.dirname, "../../../.data"));

/** Key that encrypts saved credentials. Created on first run; back it up with your database. */
function loadSecretKey(): string {
  const file = path.join(dataDir, "secret.key");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32).toString("base64");
  fs.writeFileSync(file, key + "\n", { mode: 0o600, flag: "wx" });
  return key;
}
export const secretKey = loadSecretKey();

/** Problems that stop the server from starting, with the fix for each. */
export function configErrors(): string[] {
  const errors: string[] = [];
  if (!process.env.DATABASE_URL) errors.push("DATABASE_URL is not set. Point it at a Postgres database (docker compose sets this for you).");
  if (!openaiApiKey) errors.push("OPENAI_API_KEY is not set. Add your OpenAI API key to .env.");
  return errors;
}

// Terminal executor, Windmill, and MCP servers (agent extensions, 2026-11-20). All operator-configured via env.

/** Terminal executor on the host (see agent/tools/terminal.ts). Operator-configured URL. */
export const terminalBaseUrl = process.env.AMUSE_TERMINAL_URL || undefined;
/** Shared secret the terminal tool presents to the host executor. */
export const terminalToken = process.env.AMUSE_TERMINAL_TOKEN || "";

/** Windmill instance (see agent/tools/windmill.ts). Operator-configured; token is a scoped API token. */
export const windmillBaseUrl = process.env.AMUSE_WINDMILL_BASE_URL || undefined;
export const windmillWorkspace = process.env.AMUSE_WINDMILL_WORKSPACE || "";
export const windmillToken = process.env.AMUSE_WINDMILL_TOKEN || "";

/** One MCP server entry in AMUSE_MCP_SERVERS (JSON array). Header values of the form "$env:NAME" are read from that env var at connect time, so secrets never sit inside the JSON. */
export interface McpServerConfig {
  name: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
  /** Optional tool allowlist: exact tool names, or prefix patterns ending in "*".
   *  When present, only matching tools from this server are offered to the model. */
  allowlist?: string[];
}

function loadMcpServers(): McpServerConfig[] {
  try {
    const raw = process.env.AMUSE_MCP_SERVERS;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is McpServerConfig =>
          !!s && typeof s.name === "string" && (s.transport === "http" || s.transport === "stdio") && (s.transport === "http" ? typeof s.url === "string" : typeof s.command === "string"),
      )
      .map((s) => {
        // A malformed allowlist is dropped (server behaves as unfiltered) rather than breaking the config.
        if (s.allowlist !== undefined && (!Array.isArray(s.allowlist) || s.allowlist.some((p) => typeof p !== "string" || p.length === 0))) {
          const copy = { ...s };
          delete copy.allowlist;
          return copy;
        }
        return s;
      });
  } catch {
    return [];
  }
}
export const mcpServers = loadMcpServers();

/** Debug flag: restore the full ungrouped tool menu instead of the sub-10 gateway set (default false). */
export const fullToolMenu = process.env.AMUSE_FULL_TOOL_MENU === "1" || process.env.AMUSE_FULL_TOOL_MENU === "true";

/** HardTruth v2 verification daemon (e.g. http://host.docker.internal:49281). Optional; disabled when unset. */
export const hardtruthBaseUrl = process.env.AMUSE_HARDTRUTH_URL || undefined;
/** Bearer API token for HardTruth v2 daemon (loaded via .env, matches host ~/.hardtruth/daemon_api.key). */
export const hardtruthApiToken = process.env.AMUSE_HARDTRUTH_TOKEN || "";
