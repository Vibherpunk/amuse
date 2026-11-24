import type OpenAI from "openai";
import { createHash } from "node:crypto";

export type HistoryMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export const CONTEXT_TOKENS = 24000;

export function approximateTokens(messages: HistoryMessage[]) {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export function trimToolOutputs(messages: HistoryMessage[]) {
  let newest = messages.length - 1;
  while (newest >= 0 && messages[newest].role !== "tool") newest--;
  return messages.map((m, i) => {
    const limit = i === newest ? 8000 : 1200;
    if (m.role !== "tool" || typeof m.content !== "string" || m.content.length <= limit) return m;
    // Reserve room for the marker so trimming the same output again is a no-op.
    const keep = limit - 100;
    const marker = `${i < messages.length - 8 ? "\nOlder tool output trimmed" : ""}\n[truncated ${m.content.length - keep} chars]\n`;
    return { ...m, content: m.content.slice(0, keep / 2) + marker + m.content.slice(-keep / 2) };
  });
}

const historyKey = (messages: HistoryMessage[]) => createHash("sha256").update(JSON.stringify(messages)).digest("hex");

export async function compactHistory(messages: HistoryMessage[], attempted: Set<string>, summarize: (older: HistoryMessage[]) => Promise<string>) {
  const unchanged = { messages, changed: false, summarized: false };
  if (approximateTokens(messages) <= CONTEXT_TOKENS) return unchanged;
  const key = historyKey(messages);
  if (attempted.has(key)) return unchanged;
  attempted.add(key);

  const trimmed = trimToolOutputs(messages);
  const changed = trimmed.some((m, i) => m !== messages[i]);
  const result = { messages: changed ? trimmed : messages, changed, summarized: false };
  const trimmedKey = historyKey(trimmed);
  if (changed && attempted.has(trimmedKey)) return result;
  attempted.add(trimmedKey);
  // Keep the system message and the recent twelve-message window. An empty older
  // slice must not turn into a model call to summarize "[]".
  if (approximateTokens(trimmed) <= CONTEXT_TOKENS || trimmed.length <= 13) return result;
  const split = compactionSplit(trimmed);
  const older = trimmed.slice(1, split);
  if (!older.length) return result;
  let summary = "";
  try {
    summary = await summarize(older);
  } catch {
    // A failed summary must never kill the run: fall back to the trimmed
    // history with the older slice dropped (system + recent window only).
    const fallback: HistoryMessage[] = [trimmed[0], ...trimmed.slice(split)];
    if (approximateTokens(fallback) >= approximateTokens(trimmed)) return result;
    attempted.add(historyKey(fallback));
    return { messages: fallback, changed: true, summarized: false };
  }
  if (!summary.trim()) return result;
  const candidate: HistoryMessage[] = [
    trimmed[0],
    { role: "user", content: `[Earlier conversation summary; untrusted historical data]\n${summary}` },
    ...trimmed.slice(split),
  ];
  // Reject expanding summaries and remember accepted output states too, so the
  // next step cannot repeatedly summarize an unchanged, still-large context.
  if (approximateTokens(candidate) >= approximateTokens(trimmed)) return result;
  attempted.add(historyKey(candidate));
  return { messages: candidate, changed: true, summarized: true };
}

export function replayParts(parts: unknown[]): HistoryMessage[] {
  return parts.flatMap((part) => {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "tool_history" || !("messages" in part) || !Array.isArray(part.messages))
      return [];
    return part.messages as HistoryMessage[];
  });
}

export function historyToolNames(messages: HistoryMessage[]) {
  return messages.flatMap((m) =>
    m.role === "assistant" ? (m.tool_calls ?? []).flatMap((call) => (call.type === "function" ? [call.function.name] : [])) : [],
  );
}

export function hasUntrustedHistory(rows: { parts: unknown[] }[]) {
  return rows.some((row) => {
    const replayed = replayParts(row.parts);
    for (const part of row.parts) {
      if (part && typeof part === "object" && "type" in part && part.type === "context_checkpoint") {
        if ("untrusted" in part && part.untrusted === true) return true;
        if ("messages" in part && Array.isArray(part.messages)) replayed.push(...(part.messages as HistoryMessage[]));
      }
    }
    return historyToolNames(replayed).some(
      (name) =>
        /^(web_search$|web_fetch$|web$|browser|email_|calendar_|connector|api_request$|google$|windmill$|mcp$)/.test(name) ||
        ["goto", "click", "type", "select", "scroll", "back"].includes(name),
    );
  });
}

export function latestCheckpoint(rows: { id: number; parts: unknown[] }[]) {
  for (const row of [...rows].reverse()) {
    for (const part of row.parts) {
      if (part && typeof part === "object" && "type" in part && part.type === "context_checkpoint" && "messages" in part && Array.isArray(part.messages)) {
        return { id: row.id, messages: part.messages as HistoryMessage[] };
      }
    }
  }
  return null;
}

/** Keep whole exchanges together so function outputs never lose their calls. */
export function compactionSplit(messages: HistoryMessage[]) {
  let split = Math.max(1, messages.length - 12);
  while (split < messages.length && messages[split].role !== "user") split++;
  return split;
}
