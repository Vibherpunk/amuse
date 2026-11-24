import { api } from "./api";
import { splitForSpeech, voiceStats } from "./callAudio";

type Caps = { serverSpeech: boolean };
let caps: Promise<Caps> | null = null;
export function capabilities() {
  caps ??= api<Caps>("/capabilities").catch(() => ({ serverSpeech: false }));
  return caps;
}

export function deviceSpeechSupported() {
  return typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

/** Recognise one utterance on-device. Resolves with the transcript ("" on silence). */
export function recognizeOnce(opts: { onInterim?: (t: string) => void; stop?: { stop?: () => void }; onError?: (e: string) => void } = {}): Promise<string> {
  // Automated-test hook: a test can queue utterances on window.__amuseTestSpeech (real users never set it).
  const queued = (window as any).__amuseTestSpeech as string[] | undefined;
  if (queued?.length) {
    const t = queued.shift()!;
    return new Promise((r) => setTimeout(() => (opts.onInterim?.(t), r(t)), 600));
  }
  return new Promise((resolve) => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return resolve("");
    const rec = new SR();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = "";
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      opts.onInterim?.(finalText + interim);
    };
    rec.onerror = (e: any) => (opts.onError?.(String(e?.error ?? "error")), resolve(finalText.trim()));
    rec.onend = () => resolve(finalText.trim());
    if (opts.stop) opts.stop.stop = () => rec.stop();
    rec.start();
  });
}

/** Speak text on-device. Resolves when finished. */
export function speakOnDevice(text: string): Promise<void> {
  ((window as any).__amuseSpoken ??= []).push(text);
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = speechSynthesis.getVoices().find((x) => /^en/i.test(x.lang) && /female|samantha|google us/i.test(x.name)) ?? null;
    if (v) u.voice = v;
    u.rate = 1.03;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

export type VoiceEngine = "device" | "natural";
const ENGINE_KEY = "amuse.voiceEngine";

/** Calls use the browser's own speech by default: instant, free, and no load on the server. */
export function deviceVoiceAvailable() {
  return deviceSpeechSupported() && typeof window !== "undefined" && "speechSynthesis" in window;
}
export function voiceEngine(): VoiceEngine {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(ENGINE_KEY) : null;
  if (v === "natural" || (v === "device" && deviceVoiceAvailable())) return v;
  return "natural";
}
export function setVoiceEngine(v: VoiceEngine) {
  localStorage.setItem(ENGINE_KEY, v);
}

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
    speechSynthesis.addEventListener("voiceschanged", () => (clearTimeout(t), resolve(speechSynthesis.getVoices())), { once: true });
  });
}

/** The most natural English voice this browser offers (Edge "Natural", Apple "Premium/Enhanced", Google US English). */
export async function bestDeviceVoice(): Promise<SpeechSynthesisVoice | null> {
  const lang = (navigator.language || "en-US").slice(0, 2).toLowerCase();
  const all = await loadVoices();
  const pool = all.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const score = (v: SpeechSynthesisVoice) =>
    (/natural/i.test(v.name) ? 50 : 0) +
    (/premium/i.test(v.name) ? 40 : 0) +
    (/enhanced/i.test(v.name) ? 30 : 0) +
    (/google us english/i.test(v.name) ? 25 : 0) +
    (/samantha|ava|zoe|allison|aria|jenny|serena/i.test(v.name) ? 15 : 0) +
    (/en-us/i.test(v.lang) ? 5 : 0) +
    (v.default ? 1 : 0);
  return (pool.length ? pool : all).sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** Speak sentence by sentence on-device (Chrome cuts off long single utterances). Resolves when done or stopped. */
export async function speakSentences(text: string, opts: { stop: { stopped: boolean }; onStart: () => void; onLevel: (l: number) => void }) {
  const voice = await bestDeviceVoice();
  const stats = voiceStats();
  speechSynthesis.cancel();
  let started = false;
  const pulse = setInterval(() => started && opts.onLevel(0.35 + 0.45 * Math.abs(Math.sin(performance.now() / 140))), 80);
  try {
    for (const part of splitForSpeech(text)) {
      if (opts.stop.stopped) return;
      await new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(part);
        if (voice) {
          u.voice = voice;
          u.lang = voice.lang;
        }
        u.rate = 1.05;
        const words = part.split(/\s+/).length;
        const guard = setTimeout(resolve, Math.max(5000, words * 700));
        const done = () => (clearTimeout(guard), stats.chunksPlayed++, resolve());
        u.onstart = () => {
          if (!started) {
            started = true;
            opts.onStart();
          }
        };
        u.onend = done;
        u.onerror = done;
        speechSynthesis.speak(u);
      });
    }
  } finally {
    clearInterval(pulse);
    opts.onLevel(0);
  }
}
