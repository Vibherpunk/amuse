import type OpenAI from "openai";
import { checkModelBudget, MODELS, openai } from "./ai";
import { retryable } from "../agent/robustness";
import { OWNER_ID } from "../middlewares/owner";

/**
 * Chat layer over the OpenAI Responses API, with streaming and tool calls. Callers keep using
 * Chat Completions-style messages and tools; they're converted here. Current OpenAI models only
 * support function tools with reasoning through the Responses API.
 */
type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type Tool = OpenAI.Chat.Completions.ChatCompletionTool;

export interface ToolCall {
  id: string;
  name: string;
  args: string;
}
export interface LlmResult {
  text: string;
  toolCalls: ToolCall[];
  tokensIn: number;
  tokensOut: number;
  reasoning: OpenAI.Responses.ResponseReasoningItem[];
  truncated?: boolean;
}

export interface ReasoningTurn {
  messageIndex: number;
  items: OpenAI.Responses.ResponseReasoningItem[];
}

export const CHAT_MODELS = { agent: MODELS.agent, fast: MODELS.fast };
const REASONING_EFFORT = (process.env.AMUSE_REASONING_EFFORT ?? "low") as "low" | "medium" | "high" | "xhigh";
const LLM_API = (process.env.AMUSE_LLM_API ?? "responses").toLowerCase();

function textOf(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join("");
  return "";
}

export function toInput(messages: Msg[], json = false, reasoning: ReasoningTurn[] = []) {
  let instructions = "";
  const input: any[] = [];
  for (const [index, m] of messages.entries()) {
    let pushedReasoning = false;
    for (const turn of reasoning) {
      if (turn.messageIndex === index && turn.items.length > 0) {
        input.push(...turn.items);
        pushedReasoning = true;
      }
    }
    if (m.role === "system" || (m.role as string) === "developer") {
      instructions += (instructions ? "\n\n" : "") + textOf((m as any).content);
    } else if (m.role === "user") {
      const content = textOf(m.content) || "(empty)";
      const prev = input[input.length - 1];
      if (!pushedReasoning && prev?.role === "user" && typeof prev.content === "string") {
        prev.content = `${prev.content}\n\n${content}`;
      } else {
        input.push({ role: "user", content });
      }
    } else if (m.role === "assistant") {
      const t = textOf(m.content);
      if (t) input.push({ role: "assistant", content: t });
      for (const tc of (m as any).tool_calls ?? [])
        input.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || "{}" });
    } else if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: (m as any).tool_call_id, output: textOf(m.content) || "(empty)" });
    }
  }
  if (json) {
    const last = input[input.length - 1];
    if (last?.role === "user" && typeof last.content === "string") {
      last.content = `${last.content}\n\nRespond with a single valid JSON object only.`;
    } else {
      input.push({ role: "user", content: "Respond with a single valid JSON object only." });
    }
  }
  return { instructions: instructions || undefined, input };
}

const toTools = (tools?: Tool[]) =>
  tools?.length
    ? tools.map((t: any) => ({
        type: "function" as const,
        name: t.function.name,
        description: t.function.description ?? "",
        parameters: t.function.parameters ?? { type: "object", properties: {} },
        strict: false,
      }))
    : undefined;

/** Some local models (e.g. Gemma/Qwen/Inkling) leak chat-template control tokens into visible text. Strip them. */
export function cleanModelText(t: string): string {
  return t
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .replace(/<\|channel>thought\s*<channel\|>/g, "")
    .replace(/<\|channel>thought/g, "")
    .replace(/<channel\|>/g, "")
    .replace(/<start_of_turn>/g, "")
    .replace(/<end_of_turn>/g, "")
    .replace(/<\|tool_call>/g, "")
    .replace(/<\|im_end\|>/g, "")
    .replace(/<\|im_start\|>/g, "")
    .replace(/<\|end_message\|>/g, "");
}

/** Streaming cleaner: holds back a tail that may be a control-token marker split across deltas. */
export class ModelTextCleaner {
  private buf = "";
  private static MARKERS = [
    "<|channel>thought",
    "<|channel>",
    "<channel|>",
    "<start_of_turn>",
    "<end_of_turn>",
    "<|tool_call>",
    "<|im_end|>",
    "<|im_start|>",
    "<|end_message|>",
  ];
  push(delta: string): string {
    this.buf += delta;
    const cleaned = cleanModelText(this.buf);
    let hold = 0;
    for (const m of ModelTextCleaner.MARKERS) {
      for (let k = 1; k < m.length; k++) {
        if (cleaned.endsWith(m.slice(0, k))) hold = Math.max(hold, k);
      }
    }
    const out = cleaned.slice(0, cleaned.length - hold);
    this.buf = cleaned.slice(cleaned.length - hold);
    return out;
  }
  flush(): string {
    const rest = this.buf;
    this.buf = "";
    // A leftover fragment that is only a partial marker is dropped, not shown.
    if (ModelTextCleaner.MARKERS.some((m) => m.startsWith(rest))) return "";
    return cleanModelText(rest);
  }
}

export function fromResponse(r: any, streamedText?: string): LlmResult {
  if (r?.status === "failed") throw new Error(r.error?.message ?? "The model request failed");
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const item of r?.output ?? []) {
    if (item.type === "message") for (const c of item.content ?? []) if (c.type === "output_text") text += c.text;
    if (item.type === "function_call") toolCalls.push({ id: item.call_id, name: item.name, args: item.arguments ?? "{}" });
  }
  const incomplete = r?.status === "incomplete";
  if (incomplete && (!text.trim() || toolCalls.length)) throw new Error("The model response was incomplete; no usable answer was returned.");
  return {
    text: cleanModelText(streamedText ?? text) + (incomplete ? "\n\n[Response truncated]" : ""),
    toolCalls,
    tokensIn: r?.usage?.input_tokens ?? 0,
    tokensOut: r?.usage?.output_tokens ?? 0,
    reasoning: (r?.output ?? []).filter((i: { type: string }) => i.type === "reasoning"),
    truncated: incomplete,
  };
}

async function finishResponse(r: OpenAI.Responses.Response, streamedText?: string) {
  try {
    return fromResponse(r, streamedText);
  } catch (error) {
    // Even an unusable completion consumed tokens; normal completions are metered by their callers.
    const { record } = await import("../agent/usage");
    await record(OWNER_ID, { tokensIn: r.usage?.input_tokens ?? 0, tokensOut: r.usage?.output_tokens ?? 0 });
    throw error;
  }
}

export interface ChatOpts {
  model: string;
  messages: Msg[];
  tools?: Tool[];
  toolChoice?: "auto" | "required";
  maxTokens?: number;
  json?: boolean;
  onText?: (delta: string) => void;
  signal?: { stopped: boolean };
  reasoning?: ReasoningTurn[];
}

export async function chat(o: ChatOpts): Promise<LlmResult> {
  for (let attempt = 0; ; attempt++) {
    await checkModelBudget();
    let emitted = false;
    try {
      return await chatOnce({
        ...o,
        onText: o.onText
          ? (d) => {
              emitted = true;
              o.onText!(d);
            }
          : undefined,
      });
    } catch (e) {
      if (emitted || o.signal?.stopped || attempt >= 2 || !retryable(e)) throw e;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

async function chatOnceChatCompletions(o: ChatOpts): Promise<LlmResult> {
  const messages: Msg[] = o.json
    ? [...o.messages, { role: "user", content: "Respond with a single valid JSON object only." }]
    : o.messages;
  const params: any = {
    model: o.model,
    messages,
    ...(o.tools?.length ? { tools: o.tools } : {}),
    ...(o.tools?.length && o.toolChoice === "required" ? { tool_choice: "required" } : {}),
    ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
    reasoning_effort: REASONING_EFFORT,
    ...(o.json ? { response_format: { type: "json_object" } } : {}),
  };
  if (!o.onText) {
    const r = await openai.chat.completions.create(params, { maxRetries: 0 });
    const choice = r.choices?.[0];
    const msg = choice?.message;
    const text = cleanModelText(msg?.content ?? "");
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? [])
      .filter((tc: any) => tc.type === "function" || tc.function)
      .map((tc: any, idx: number) => ({
        id: tc.id || `call_${idx}`,
        name: tc.function?.name ?? "",
        args: tc.function?.arguments || "{}",
      }));
    const incomplete = choice?.finish_reason === "length";
    if (incomplete && (!text.trim() || toolCalls.length)) {
      const { record } = await import("../agent/usage");
      await record(OWNER_ID, { tokensIn: r.usage?.prompt_tokens ?? 0, tokensOut: r.usage?.completion_tokens ?? 0 });
      throw new Error("The model response was incomplete; no usable answer was returned.");
    }
    return {
      text: text + (incomplete ? "\n\n[Response truncated]" : ""),
      toolCalls,
      tokensIn: r.usage?.prompt_tokens ?? 0,
      tokensOut: r.usage?.completion_tokens ?? 0,
      reasoning: [],
      truncated: incomplete,
    };
  }

  const stream: any = await openai.chat.completions.create(
    { ...params, stream: true, stream_options: { include_usage: true } },
    { maxRetries: 0 },
  );
  let rawText = "";
  let finishReason: string | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  const tcByIdx = new Map<number, { id: string; name: string; args: string }>();
  const cleaner = new ModelTextCleaner();
  for await (const chunk of stream) {
    if (o.signal?.stopped) {
      stream.controller?.abort();
      break;
    }
    if (chunk.usage) {
      tokensIn = chunk.usage.prompt_tokens ?? tokensIn;
      tokensOut = chunk.usage.completion_tokens ?? tokensOut;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (delta?.content) {
      rawText += delta.content;
      const out = cleaner.push(delta.content);
      if (out) o.onText(out);
    }
    for (const tc of delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const cur = tcByIdx.get(idx) ?? { id: tc.id || `call_${idx}`, name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      tcByIdx.set(idx, cur);
    }
  }
  const rest = cleaner.flush();
  if (rest) o.onText(rest);
  const toolCalls: ToolCall[] = [...tcByIdx.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ id: v.id, name: v.name, args: v.args || "{}" }));
  const incomplete = finishReason === "length";
  if (incomplete && (!rawText.trim() || toolCalls.length)) {
    const { record } = await import("../agent/usage");
    await record(OWNER_ID, { tokensIn, tokensOut });
    throw new Error("The model response was incomplete; no usable answer was returned.");
  }
  return {
    text: cleanModelText(rawText) + (incomplete ? "\n\n[Response truncated]" : ""),
    toolCalls,
    tokensIn,
    tokensOut,
    reasoning: [],
    truncated: incomplete,
  };
}

async function chatOnce(o: ChatOpts): Promise<LlmResult> {
  if (LLM_API === "chat") return chatOnceChatCompletions(o);
  const { instructions, input } = toInput(o.messages, o.json, o.reasoning);
  const params: any = {
    model: o.model,
    instructions: o.json ? (instructions ? instructions + "\n\n" : "") + "Respond with a single valid JSON object only." : instructions,
    input,
    include: ["reasoning.encrypted_content"],
    tools: toTools(o.tools),
    reasoning: { effort: REASONING_EFFORT },
    store: false,
    ...(o.maxTokens ? { max_output_tokens: o.maxTokens } : {}),
    ...(o.tools?.length && o.toolChoice === "required" ? { tool_choice: "required" } : {}),
    ...(o.json ? { text: { format: { type: "json_object" } } } : {}),
  };
  if (!o.onText) return finishResponse(await openai.responses.create(params, { maxRetries: 0 }));

  const stream: any = await openai.responses.create({ ...params, stream: true }, { maxRetries: 0 });
  let text = "";
  let final: any = null;
  const cleaner = new ModelTextCleaner();
  const emit = (delta: string) => {
    text += delta;
    if (!o.onText) return;
    const out = cleaner.push(delta);
    if (out) o.onText(out);
  };
  for await (const ev of stream) {
    if (o.signal?.stopped) {
      stream.controller?.abort();
      break;
    }
    if (ev.type === "response.output_text.delta") {
      emit(ev.delta);
    } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
      final = ev.response;
    } else if (ev.type === "response.failed") {
      return finishResponse(ev.response, text);
    } else if (ev.type === "error") {
      throw new Error(ev.message ?? "The model request failed");
    }
  }
  if (o.onText) {
    const rest = cleaner.flush();
    if (rest) o.onText(rest);
  }
  if (!final && !o.signal?.stopped) throw new Error("The model stream ended before completion.");
  return final ? finishResponse(final, text) : { text, toolCalls: [], tokensIn: 0, tokensOut: 0, reasoning: [] };
}

export function extractJson<T>(text: string): T {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  try {
    return JSON.parse(s >= 0 ? text.slice(s, e + 1) : text) as T;
  } catch {
    throw new Error("The model returned invalid JSON.");
  }
}
