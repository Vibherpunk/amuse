import OpenAI from "openai";
import { AsyncLocalStorage } from "node:async_hooks";
import { MODELS, openaiApiKey, openaiBaseUrl, audioBaseUrl, audioApiKey, speechBaseUrl, speechApiKey, transcribeBaseUrl, transcribeApiKey, imageBaseUrl, imageApiKey, speechVoiceMap } from "./config";
import { OWNER_ID } from "../middlewares/owner";

export { MODELS };

const audioOwner = new AsyncLocalStorage<string>();
export function withAudioUsage<T>(userId: string, work: () => Promise<T>) {
  return audioOwner.run(userId, work);
}

export async function checkModelBudget() {
  const { assertWithinLimit } = await import("../agent/usage");
  await assertWithinLimit(OWNER_ID);
  return OWNER_ID;
}

import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

// Airlock (the local egress gate) rejects any request carrying Origin or
// Sec-Fetch headers, which undici fetch adds automatically. Calls whose URL
// targets the gate are therefore sent with node:http, which adds neither.
function gateFetch(input: any, init: any): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const urlStr = typeof input === "string" ? input : input.url;
    const url = new URL(urlStr);
    const headers: Record<string, string> = {};
    const addHeaders = (h: any) => {
      if (!h) return;
      if (typeof h.forEach === "function") h.forEach((v: string, k: string) => { headers[k] = v; });
      else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
      else for (const [k, v] of Object.entries(h)) headers[k] = String(v);
    };
    if (typeof input === "object" && input.headers) addHeaders(input.headers);
    addHeaders(init?.headers);
    const method = init?.method || (typeof input === "object" ? input.method : undefined) || "GET";
    const body = init?.body ?? undefined;
    if (body != null && headers["content-length"] === undefined) {
      headers["content-length"] = String(Buffer.byteLength(body as any));
    }
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, { method, headers }, (res) => {
      const rh = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) v.forEach((x) => rh.append(k, x));
        else if (v != null) rh.set(k, v);
      }
      const status = res.statusCode || 502;
      const noBody = status === 204 || status === 304;
      resolve(new Response(noBody ? null : (Readable.toWeb(res as any) as any), {
        status, statusText: res.statusMessage, headers: rh,
      }));
    });
    req.on("error", reject);
    const signal = init?.signal;
    if (signal) {
      if (signal.aborted) { req.destroy(new Error("aborted")); return; }
      signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
    }
    if (body != null) req.write(body as any);
    req.end();
  });
}

function isGateUrl(input: any): boolean {
  const u = typeof input === "string" ? input : input?.url || "";
  return u.includes(":8440/");
}

export const openai = new OpenAI({
  apiKey: openaiApiKey || "missing",
  baseURL: openaiBaseUrl,
  maxRetries: 2,
  fetch: async (input, init) => {
    await checkModelBudget();
    if (isGateUrl(input)) return gateFetch(input, init);
    return fetch(input, init);
  },
});

function altClient(baseURL: string, apiKey: string, timeoutMs = 300_000) {
  return new OpenAI({
    apiKey,
    baseURL,
    timeout: timeoutMs,
    maxRetries: 1,
    fetch: async (input, init) => {
      await checkModelBudget();
      return fetch(input, init);
    },
  });
}

/** Audio (speech + transcription) client: a separate provider when AMUSE_AUDIO_BASE_URL is set, else the main one. */
export const audioOpenai = audioBaseUrl ? altClient(audioBaseUrl, audioApiKey, 300_000) : openai;
/** Speech-only client: AMUSE_SPEECH_BASE_URL when set (e.g. Pocket TTS on the host), else the shared audio client. */
export const speechOpenai = speechBaseUrl ? altClient(speechBaseUrl, speechApiKey, 300_000) : audioOpenai;
/** Transcription-only client: AMUSE_TRANSCRIBE_BASE_URL when set (e.g. Speaches), else the shared audio client. */
export const transcribeOpenai = transcribeBaseUrl ? altClient(transcribeBaseUrl, transcribeApiKey, 300_000) : audioOpenai;
/** Image generation client: a separate provider when AMUSE_IMAGE_BASE_URL is set, else the main one. */
export const imageOpenai = imageBaseUrl ? altClient(imageBaseUrl, imageApiKey, 240_000) : openai;

/** Translate a voice name to the audio provider's voice when a mapping is configured. */
export const mapSpeechVoice = (voice: string): string => speechVoiceMap[voice] ?? voice;

/** One-shot JSON helper on the fast model. */
export async function jsonCompletion<T>(system: string, user: string): Promise<{ data: T; tokensIn: number; tokensOut: number }> {
  const { chat, extractJson } = await import("./llm");
  const r = await chat({
    model: MODELS.fast,
    json: true,
    maxTokens: 256,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  try {
    if (r.truncated) throw new Error("The model returned truncated JSON.");
    return { data: extractJson<T>(r.text), tokensIn: r.tokensIn, tokensOut: r.tokensOut };
  } catch (error) {
    const { record } = await import("../agent/usage");
    await record(OWNER_ID, r);
    throw error;
  }
}

export async function textCompletion(system: string, user: string) {
  const { chat } = await import("./llm");
  const r = await chat({
    model: MODELS.fast,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return { text: r.text, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
}

/** Text to speech. Returns WAV audio. */
export async function synthesizeSpeech(text: string, voice = "alloy"): Promise<Buffer> {
  const res = await speechOpenai.audio.speech.create({ model: MODELS.speech, voice: mapSpeechVoice(voice) as any, input: text, response_format: "wav" });
  // Agent podcasts may fail after some segments. Meter each completed call, not the whole podcast.
  // Voice HTTP routes already meter their single call.
  const userId = audioOwner.getStore();
  if (userId) {
    const { record } = await import("../agent/usage");
    await record(userId, { audioSeconds: speechSeconds(text) });
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Rough spoken duration of text, for usage metering (about 2.5 words per second). */
export const speechSeconds = (text: string) => Math.max(1, Math.round(text.split(/\s+/).filter(Boolean).length / 2.5));
